#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <node_api.h>

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

struct Event {
  std::string type;
  uint32_t clientId;
  std::vector<char> data;
};

struct Client {
  uint32_t id;
  HANDLE pipe;
  std::thread reader;
  std::mutex writeMutex;
  std::atomic_bool closed{false};
  std::atomic_bool finished{false};
};

struct Server {
  uint32_t id;
  std::wstring path;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  HANDLE stopEvent = nullptr;
  HANDLE pendingPipe = INVALID_HANDLE_VALUE;
  napi_threadsafe_function events = nullptr;
  std::thread acceptor;
  std::mutex mutex;
  std::map<uint32_t, std::shared_ptr<Client>> clients;
  std::atomic_bool closing{false};
  std::atomic_uint32_t queueFullCount{0};
  uint32_t nextClientId = 1;
  bool protectedDacl = false;
  bool currentUserOnly = false;
  uint32_t aceCount = 0;
};

std::mutex registryMutex;
std::map<uint32_t, std::shared_ptr<Server>> servers;
std::atomic_uint32_t nextServerId{1};

std::string windowsError(const char* operation) {
  return std::string(operation) + " failed (Win32 " + std::to_string(GetLastError()) + ")";
}

void throwError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

void callJs(napi_env env, napi_value callback, void*, void* raw) {
  std::unique_ptr<Event> event(static_cast<Event*>(raw));
  if (!env || !callback) return;
  napi_value object, type, id, data, ignored, receiver;
  napi_create_object(env, &object);
  napi_create_string_utf8(env, event->type.c_str(), NAPI_AUTO_LENGTH, &type);
  napi_set_named_property(env, object, "type", type);
  napi_create_uint32(env, event->clientId, &id);
  napi_set_named_property(env, object, "clientId", id);
  if (event->type == "data") {
    napi_create_buffer_copy(env, event->data.size(), event->data.data(), nullptr, &data);
    napi_set_named_property(env, object, "data", data);
  }
  napi_value argv[] = {object};
  napi_get_undefined(env, &receiver);
  napi_call_function(env, receiver, callback, 1, argv, &ignored);
}

bool emit(const std::shared_ptr<Server>& server, const char* type,
          uint32_t clientId, const char* data = nullptr, size_t size = 0) {
  auto* event = new Event{type, clientId, {}};
  if (data && size) event->data.assign(data, data + size);
  const napi_status status = napi_call_threadsafe_function(
      server->events, event, napi_tsfn_nonblocking);
  if (status != napi_ok) {
    delete event;
    if (status == napi_queue_full) ++server->queueFullCount;
    if (status == napi_closing) {
      server->closing = true;
      SetEvent(server->stopEvent);
    }
    return false;
  }
  return true;
}

bool emitControl(const std::shared_ptr<Server>& server, const char* type,
                 uint32_t clientId) {
  // A client disconnect never joins this reader from a data callback. Once JS
  // drains the bounded queue, the close event lets JS reclaim the client.
  while (!server->closing) {
    if (emit(server, type, clientId)) return true;
    Sleep(1);
  }
  return false;
}

bool emitData(const std::shared_ptr<Server>& server,
              const std::shared_ptr<Client>& client, const char* data, size_t size) {
  // Pause this pipe reader at the bounded queue instead of dropping its data
  // or disconnecting an unrelated client when another pipe fills the queue.
  while (!server->closing && !client->closed) {
    if (emit(server, "data", client->id, data, size)) return true;
    Sleep(1);
  }
  return false;
}

bool makeSecurityDescriptor(Server& server) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD length = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &length);
  std::vector<unsigned char> storage(length);
  const bool gotUser = GetTokenInformation(token, TokenUser, storage.data(), length, &length) != 0;
  CloseHandle(token);
  if (!gotUser) return false;
  auto* user = reinterpret_cast<TOKEN_USER*>(storage.data());
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &sid)) return false;
  // D:P makes the DACL protected. Only the current token's user SID has an ACE.
  // Neither Everyone nor Anonymous receives the default Named Pipe read grant.
  const std::wstring sddl = std::wstring(L"D:P(A;;GA;;;") + sid + L")";
  LocalFree(sid);
  return ConvertStringSecurityDescriptorToSecurityDescriptorW(
      sddl.c_str(), SDDL_REVISION_1, &server.descriptor, nullptr) != 0;
}

HANDLE makePipe(Server& server, bool first) {
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), server.descriptor, FALSE};
  return CreateNamedPipeW(
      server.path.c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
          (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, &attributes);
}

bool inspectSecurity(Server& server, HANDLE pipe) {
  PSECURITY_DESCRIPTOR actual = nullptr;
  PACL dacl = nullptr;
  const DWORD result = GetSecurityInfo(pipe, SE_KERNEL_OBJECT,
                                       DACL_SECURITY_INFORMATION,
                                       nullptr, nullptr, &dacl, nullptr, &actual);
  if (result != ERROR_SUCCESS) return false;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  bool valid = GetSecurityDescriptorControl(actual, &control, &revision) &&
               (control & SE_DACL_PROTECTED) != 0 && dacl && dacl->AceCount == 1;
  if (valid) {
    void* ace = nullptr;
    valid = GetAce(dacl, 0, &ace) != 0;
    if (valid) {
      auto* allowed = static_cast<ACCESS_ALLOWED_ACE*>(ace);
      valid = allowed->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
              ((allowed->Mask & GENERIC_ALL) == GENERIC_ALL ||
               (allowed->Mask & (FILE_READ_DATA | FILE_WRITE_DATA)) ==
                   (FILE_READ_DATA | FILE_WRITE_DATA));
      if (valid) {
        HANDLE token = nullptr;
        DWORD length = 0;
        valid = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) != 0;
        if (valid) {
          GetTokenInformation(token, TokenUser, nullptr, 0, &length);
          std::vector<unsigned char> storage(length);
          valid = GetTokenInformation(token, TokenUser, storage.data(), length, &length) != 0;
          if (valid) {
            auto* user = reinterpret_cast<TOKEN_USER*>(storage.data());
            valid = EqualSid(user->User.Sid, &allowed->SidStart) != 0;
          }
          CloseHandle(token);
        }
      }
    }
  }
  if (valid && !server.currentUserOnly) {
    server.protectedDacl = true;
    server.aceCount = dacl->AceCount;
    server.currentUserOnly = true;
  }
  LocalFree(actual);
  return valid;
}

void readClient(const std::shared_ptr<Server>& server, const std::shared_ptr<Client>& client) {
  HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (ready) {
    char buffer[16384];
    while (!server->closing && !client->closed) {
      OVERLAPPED operation{};
      operation.hEvent = ready;
      ResetEvent(ready);
      DWORD count = 0;
      const BOOL immediate = ReadFile(client->pipe, buffer, sizeof(buffer), &count, &operation);
      if (!immediate) {
        const DWORD error = GetLastError();
        if (error != ERROR_IO_PENDING) break;
        HANDLE waits[] = {server->stopEvent, ready};
        if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0 + 1) {
          CancelIoEx(client->pipe, &operation);
          GetOverlappedResult(client->pipe, &operation, &count, TRUE);
          break;
        }
        if (!GetOverlappedResult(client->pipe, &operation, &count, FALSE)) break;
      }
      if (count == 0 || !emitData(server, client, buffer, count)) break;
    }
    CloseHandle(ready);
  }
  client->finished = true;
  emitControl(server, "close", client->id);
  napi_release_threadsafe_function(server->events, napi_tsfn_release);
}

void finishClient(const std::shared_ptr<Client>& client) {
  client->closed = true;
  CancelIoEx(client->pipe, nullptr);
  if (client->reader.joinable()) client->reader.join();
  std::lock_guard<std::mutex> writeLock(client->writeMutex);
  DisconnectNamedPipe(client->pipe);
  CloseHandle(client->pipe);
}

void acceptClients(const std::shared_ptr<Server>& server) {
  while (!server->closing) {
    HANDLE pipe;
    {
      std::lock_guard<std::mutex> lock(server->mutex);
      pipe = server->pendingPipe;
    }
    HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!ready) { emitControl(server, "fatal", 0); break; }
    OVERLAPPED operation{};
    operation.hEvent = ready;
    bool connected = ConnectNamedPipe(pipe, &operation) != 0;
    if (!connected) {
      const DWORD error = GetLastError();
      if (error == ERROR_PIPE_CONNECTED) connected = true;
      else if (error == ERROR_IO_PENDING) {
        HANDLE waits[] = {server->stopEvent, ready};
        if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) {
          DWORD ignored = 0;
          connected = GetOverlappedResult(pipe, &operation, &ignored, FALSE) != 0;
        } else {
          CancelIoEx(pipe, &operation);
          DWORD ignored = 0;
          GetOverlappedResult(pipe, &operation, &ignored, TRUE);
        }
      }
    }
    CloseHandle(ready);
    if (server->closing) break;
    if (!connected) { emitControl(server, "fatal", 0); break; }
    HANDLE next = makePipe(*server, false);
    if (next == INVALID_HANDLE_VALUE || !inspectSecurity(*server, next)) {
      if (next != INVALID_HANDLE_VALUE) CloseHandle(next);
      emitControl(server, "fatal", 0);
      break;
    }
    auto client = std::make_shared<Client>();
    {
      std::lock_guard<std::mutex> lock(server->mutex);
      server->pendingPipe = next;
      client->id = server->nextClientId++;
      client->pipe = pipe;
      server->clients.emplace(client->id, client);
    }
    if (napi_acquire_threadsafe_function(server->events) != napi_ok) {
      {
        std::lock_guard<std::mutex> lock(server->mutex);
        server->clients.erase(client->id);
      }
      finishClient(client);
      break;
    }
    if (!emitControl(server, "connect", client->id)) {
      napi_release_threadsafe_function(server->events, napi_tsfn_release);
      {
        std::lock_guard<std::mutex> lock(server->mutex);
        server->clients.erase(client->id);
      }
      finishClient(client);
      continue;
    }
    client->reader = std::thread(readClient, server, client);
  }
  napi_release_threadsafe_function(server->events, napi_tsfn_release);
}

std::shared_ptr<Server> getServer(uint32_t id) {
  std::lock_guard<std::mutex> lock(registryMutex);
  auto found = servers.find(id);
  return found == servers.end() ? nullptr : found->second;
}

bool getUint(napi_env env, napi_value value, uint32_t& output) {
  return napi_get_value_uint32(env, value, &output) == napi_ok;
}

napi_value start(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_valuetype callbackType;
  if (argc != 2 || napi_typeof(env, args[1], &callbackType) != napi_ok ||
      callbackType != napi_function) {
    throwError(env, "Named Pipe start requires a path and event callback");
    return nullptr;
  }
  size_t length = 0;
  if (napi_get_value_string_utf16(env, args[0], nullptr, 0, &length) != napi_ok || length > 255) {
    throwError(env, "Invalid Named Pipe path");
    return nullptr;
  }
  std::vector<char16_t> path(length + 1);
  napi_get_value_string_utf16(env, args[0], path.data(), path.size(), &length);
  auto server = std::make_shared<Server>();
  server->id = nextServerId++;
  server->path.assign(reinterpret_cast<wchar_t*>(path.data()), length);
  if (server->path.rfind(L"\\\\.\\pipe\\", 0) != 0 ||
      !makeSecurityDescriptor(*server)) {
    throwError(env, "Cannot prepare protected Named Pipe security descriptor");
    return nullptr;
  }
  server->stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  server->pendingPipe = makePipe(*server, true);
  if (!server->stopEvent || server->pendingPipe == INVALID_HANDLE_VALUE ||
      !inspectSecurity(*server, server->pendingPipe)) {
    if (server->pendingPipe != INVALID_HANDLE_VALUE) CloseHandle(server->pendingPipe);
    if (server->stopEvent) CloseHandle(server->stopEvent);
    LocalFree(server->descriptor);
    throwError(env, "Cannot bind Named Pipe with an explicit protected current-user DACL");
    return nullptr;
  }
  napi_value name;
  napi_create_string_utf8(env, "secure-named-pipe-events", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, args[1], nullptr, name, 256, 1,
                                      nullptr, nullptr, nullptr, callJs,
                                      &server->events) != napi_ok) {
    CloseHandle(server->pendingPipe);
    CloseHandle(server->stopEvent);
    LocalFree(server->descriptor);
    throwError(env, "Cannot initialize Named Pipe events");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, server->events);
  {
    std::lock_guard<std::mutex> lock(registryMutex);
    servers.emplace(server->id, server);
  }
  server->acceptor = std::thread(acceptClients, server);
  napi_value result;
  napi_create_uint32(env, server->id, &result);
  return result;
}

napi_value write(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  uint32_t serverId, clientId;
  bool isBuffer = false;
  if (argc != 3 || !getUint(env, args[0], serverId) ||
      !getUint(env, args[1], clientId) ||
      napi_is_buffer(env, args[2], &isBuffer) != napi_ok || !isBuffer) {
    throwError(env, "Invalid Named Pipe write arguments");
    return nullptr;
  }
  auto server = getServer(serverId);
  std::shared_ptr<Client> client;
  if (server) {
    std::lock_guard<std::mutex> lock(server->mutex);
    auto found = server->clients.find(clientId);
    if (found != server->clients.end()) client = found->second;
  }
  if (!client || client->closed || client->finished || server->closing) {
    throwError(env, "Named Pipe client is closed");
    return nullptr;
  }
  void* bytes;
  size_t length;
  napi_get_buffer_info(env, args[2], &bytes, &length);
  std::lock_guard<std::mutex> writeLock(client->writeMutex);
  if (client->closed || client->finished || server->closing) {
    throwError(env, "Named Pipe client is closed");
    return nullptr;
  }
  HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!ready) { throwError(env, windowsError("Named Pipe write event")); return nullptr; }
  OVERLAPPED operation{};
  operation.hEvent = ready;
  DWORD written = 0;
  bool okay = WriteFile(client->pipe, bytes, static_cast<DWORD>(length), &written, &operation) != 0;
  if (!okay && GetLastError() == ERROR_IO_PENDING) {
    if (WaitForSingleObject(ready, 1000) == WAIT_OBJECT_0) {
      okay = GetOverlappedResult(client->pipe, &operation, &written, FALSE) != 0;
    } else {
      CancelIoEx(client->pipe, &operation);
      GetOverlappedResult(client->pipe, &operation, &written, TRUE);
    }
  }
  CloseHandle(ready);
  if (!okay || written != length) {
    throwError(env, "Named Pipe write failed or timed out");
    return nullptr;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value disconnect(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  uint32_t serverId, clientId;
  if (argc != 2 || !getUint(env, args[0], serverId) || !getUint(env, args[1], clientId)) {
    throwError(env, "Invalid Named Pipe disconnect arguments");
    return nullptr;
  }
  auto server = getServer(serverId);
  if (server) {
    std::shared_ptr<Client> client;
    {
      std::lock_guard<std::mutex> lock(server->mutex);
      auto found = server->clients.find(clientId);
      if (found != server->clients.end()) client = found->second;
    }
    // Never join here: JS may be processing a data event while this reader is
    // waiting to enqueue its close event into the same bounded TSFN queue.
    if (client) {
      client->closed = true;
      CancelIoEx(client->pipe, nullptr);
    }
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value reap(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  uint32_t serverId, clientId;
  if (argc != 2 || !getUint(env, args[0], serverId) || !getUint(env, args[1], clientId)) {
    throwError(env, "Invalid Named Pipe reap arguments");
    return nullptr;
  }
  auto server = getServer(serverId);
  std::shared_ptr<Client> client;
  if (server) {
    std::lock_guard<std::mutex> lock(server->mutex);
    auto found = server->clients.find(clientId);
    if (found != server->clients.end() && found->second->finished) {
      client = found->second;
      server->clients.erase(found);
    }
  }
  // The reader already queued its close event before JS calls reap. Joining
  // it cannot require JS to drain queue capacity and cannot be a self-join.
  if (client) finishClient(client);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value stats(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  uint32_t id;
  auto server = argc == 1 && getUint(env, arg, id) ? getServer(id) : nullptr;
  if (!server) { throwError(env, "Named Pipe server is closed"); return nullptr; }
  uint32_t clients;
  {
    std::lock_guard<std::mutex> lock(server->mutex);
    clients = static_cast<uint32_t>(server->clients.size());
  }
  napi_value object, value;
  napi_create_object(env, &object);
  napi_create_uint32(env, clients, &value);
  napi_set_named_property(env, object, "clientCount", value);
  napi_create_uint32(env, server->queueFullCount.load(), &value);
  napi_set_named_property(env, object, "queueFullCount", value);
  return object;
}

napi_value security(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  uint32_t id;
  auto server = argc == 1 && getUint(env, arg, id) ? getServer(id) : nullptr;
  if (!server) { throwError(env, "Named Pipe server is closed"); return nullptr; }
  napi_value object, value;
  napi_create_object(env, &object);
  napi_get_boolean(env, server->protectedDacl, &value);
  napi_set_named_property(env, object, "protectedDacl", value);
  napi_get_boolean(env, server->currentUserOnly, &value);
  napi_set_named_property(env, object, "currentUserOnly", value);
  napi_create_uint32(env, server->aceCount, &value);
  napi_set_named_property(env, object, "aceCount", value);
  napi_get_boolean(env, true, &value);
  napi_set_named_property(env, object, "rejectRemoteClients", value);
  return object;
}

napi_value stop(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  uint32_t id;
  if (argc != 1 || !getUint(env, arg, id)) {
    throwError(env, "Invalid Named Pipe server identifier");
    return nullptr;
  }
  std::shared_ptr<Server> server;
  {
    std::lock_guard<std::mutex> lock(registryMutex);
    auto found = servers.find(id);
    if (found != servers.end()) { server = found->second; servers.erase(found); }
  }
  if (server) {
    server->closing = true;
    SetEvent(server->stopEvent);
    {
      std::lock_guard<std::mutex> lock(server->mutex);
      CancelIoEx(server->pendingPipe, nullptr);
    }
    if (server->acceptor.joinable()) server->acceptor.join();
    std::vector<std::shared_ptr<Client>> clients;
    {
      std::lock_guard<std::mutex> lock(server->mutex);
      for (const auto& pair : server->clients) clients.push_back(pair.second);
      server->clients.clear();
      CloseHandle(server->pendingPipe);
    }
    for (const auto& client : clients) finishClient(client);
    CloseHandle(server->stopEvent);
    LocalFree(server->descriptor);
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"write", nullptr, write, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"disconnect", nullptr, disconnect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"reap", nullptr, reap, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stats", nullptr, stats, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"security", nullptr, security, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
