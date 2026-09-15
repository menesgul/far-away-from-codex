import * as vscode from 'vscode';

let alertsEnabled = false;

export function activate(context: vscode.ExtensionContext) {
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);

	statusBarItem.command = 'far-away-from-codex.toggleAlerts';
	statusBarItem.tooltip = 'Click to enable or disable Codex phone alerts';

	const updateStatusBar = () => {
		statusBarItem.text = alertsEnabled
			? '$(bell) Codex Alerts: ON'
			: '$(bell) Codex Alerts: OFF';
	};

	const toggleCommand = vscode.commands.registerCommand(
		'far-away-from-codex.toggleAlerts',
		() => {
			alertsEnabled = !alertsEnabled;
			updateStatusBar();
		}
	);

	const testNotificationCommand = vscode.commands.registerCommand(
		'far-away-from-codex.testNotification',
		async () => {
			void vscode.window.showErrorMessage(
				'Telegram pairing and notification delivery are not available yet.'
			);
		}
	);

	updateStatusBar();
	statusBarItem.show();

	context.subscriptions.push(statusBarItem, toggleCommand, testNotificationCommand);
}

export function deactivate() {}
