# Azure DevOps PR Manager

A Visual Studio Code extension for managing Azure DevOps pull requests and monitoring pipeline status directly from your editor.

## Features

- **View Pull Requests**: Browse all active pull requests in a tree view
- **Create Pull Requests**: Create new PRs with source and target branch selection
- **Pipeline Status**: Monitor pipeline runs associated with each pull request
- **Detailed PR View**: View comprehensive PR details including description, metadata, and pipeline status
- **Quick Actions**: Open PRs in browser, refresh list, and more
- **My PRs Filter**: Filter the list to only show pull requests you created or are a reviewer on
- **PR Notifications**: Get VS Code notifications when new comments are added or reviewers change their vote

## Prerequisites

- Visual Studio Code 1.85.0 or higher
- Azure DevOps account with access to your organization
- Personal Access Token (PAT) with the following permissions:
  - Code: Read & Write
  - Build: Read

## Installation

### From Source

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Press F5 in VS Code to open a new window with the extension loaded

### Creating a VSIX Package

```bash
npm install -g vsce
vsce package
```

Then install the `.vsix` file in VS Code.

## Configuration

### Setting up Azure DevOps Connection

1. Open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Run "Azure DevOps: Configure Connection"
3. Enter the following information:
   - **Personal Access Token**: Your PAT with appropriate permissions

### Creating a Personal Access Token

1. Go to Azure DevOps
2. Click on your profile icon → Security → Personal access tokens
3. Click "New Token"
4. Give it a name and set expiration
5. Select the following scopes:
   - Code: Read & Write
   - Build: Read
6. Copy the generated token

## Usage

### Viewing Pull Requests

1. Open the Azure DevOps view in the Activity Bar
2. The "Pull Requests" section shows all active PRs
3. Click on a PR to view details
4. Expand a PR to see associated pipeline runs

### Creating a Pull Request

1. Click the "+" icon in the Pull Requests view title bar
2. Or run "Azure DevOps: Create Pull Request" from the Command Palette
3. Select source and target branches
4. Enter a title and optional description
5. The PR will be created and appear in the list

### PR Branch Prefill Settings

Two settings are available to speed up PR creation (VS Code Settings → Azure DevOps):

- **Prefill Source Branch** (`azureDevOps.prefillSourceBranch`): When enabled, the current active git branch is automatically moved to the top of the source branch picker.
- **Default Target Branch** (`azureDevOps.defaultTargetBranch`): Set a branch name (e.g. `main`, `develop`) to have it moved to the top of the target branch picker by default.

### Filtering Pull Requests

To show only pull requests you're involved in:

1. Open VS Code Settings (Ctrl+, / Cmd+,) and search for "Azure DevOps"
2. Enable **Filter My Pull Requests** (`azureDevOps.filterMyPullRequests`)
3. Your identity is auto-detected from your PAT. If auto-detection doesn't work, set your email manually in **User Email** (`azureDevOps.userEmail`)

When enabled, the list shows only PRs where you are the author or a reviewer.

### PR Notifications

The extension polls Azure DevOps in the background and shows a VS Code notification when:

- A new comment is added to a PR you're involved in
- A reviewer changes their vote on a PR you're involved in

Clicking **Open PR** in the notification opens the PR details panel.

**Notification settings** (VS Code Settings → Azure DevOps):

- **Notifications Enabled** (`azureDevOps.notifications.enabled`): Toggle notifications on/off (default: on)
- **Poll Interval** (`azureDevOps.notifications.pollIntervalSeconds`): How often to check for activity in seconds (default: 60, minimum: 15)

### PR Link Redirection

When enabled, clicking a pull request link inside the PR detail view opens the referenced PR within the extension instead of in the browser. PR URLs in descriptions and comments are automatically made clickable.

**Setting** (VS Code Settings → Azure DevOps):

- **Redirect PR Links to Extension** (`azureDevOps.redirectPrLinksToExtension`): Open PR links inside the extension instead of the browser (default: on)

### Pipeline Status

- Pipeline runs are shown under each PR in the tree view
- Pipeline status is color-coded:
  - Green: Succeeded
  - Red: Failed
  - Yellow: In Progress
  - Orange: Partially Succeeded
  - Gray: Canceled
- Click on a pipeline to open it in your browser

### Commands

- `Azure DevOps: Configure Connection` - Set up your Azure DevOps connection
- `Azure DevOps: Refresh Pull Requests` - Refresh the PR list
- `Azure DevOps: Create Pull Request` - Create a new pull request
- `Azure DevOps: View Pull Request Details` - View detailed PR information
- `Azure DevOps: Open Pull Request in Browser` - Open PR in Azure DevOps web interface

## Future Enhancements

- [ ] Configurable notification sound/badge
