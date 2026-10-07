if (process.platform !== 'win32') {
  throw new Error('Windows Named Pipe security is only available on Windows');
}
module.exports = require('./build/Release/secure_pipe.node');
