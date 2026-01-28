import * as vscode from 'vscode';
import { PullRequest, PipelineRun, AzureDevOpsClient, PullRequestChange, FileDiff, FileInfo, Reviewer, CurrentUser, CommentThread, PRComment } from './azureDevOpsClient';

export class PullRequestWebviewPanel {
    private static currentPanel: PullRequestWebviewPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private organizationUrl: string;
    private project: string;
    private repository: string;
    private sourceRef: string = '';
    private targetRef: string = '';
    private currentUser: CurrentUser | undefined;
    private commentThreads: CommentThread[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly client: AzureDevOpsClient,
        private pullRequest: PullRequest,
        organizationUrl: string,
        project: string,
        repository: string
    ) {
        this.organizationUrl = organizationUrl;
        this.project = project;
        this.repository = repository;
        this.panel = panel;

        // Set the webview's initial html content
        this.update();

        // Listen for when the panel is disposed
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Update the content based on view changes
        this.panel.onDidChangeViewState(
            () => {
                if (this.panel.visible) {
                    this.update();
                }
            },
            null,
            this.disposables
        );

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'copyLink':
                        await vscode.env.clipboard.writeText(message.url);
                        vscode.window.showInformationMessage('PR link copied to clipboard');
                        return;
                    case 'fetchDiff':
                        try {
                            const diff = await this.client.getFileDiff(
                                message.filePath,
                                message.changeType,
                                this.sourceRef,
                                this.targetRef
                            );
                            this.panel.webview.postMessage({
                                command: 'diffLoaded',
                                index: message.index,
                                diff: {
                                    originalContent: diff.originalContent,
                                    modifiedContent: diff.modifiedContent
                                }
                            });
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                            this.panel.webview.postMessage({
                                command: 'diffError',
                                index: message.index,
                                error: errorMessage
                            });
                        }
                        return;
                    case 'vote':
                        try {
                            await this.client.votePullRequest(this.pullRequest.pullRequestId, message.vote);
                            vscode.window.showInformationMessage(this.getVoteMessage(message.vote));
                            // Refresh the PR to show updated vote
                            this.pullRequest = await this.client.getPullRequest(this.pullRequest.pullRequestId);
                            this.update();
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                            vscode.window.showErrorMessage(`Failed to vote: ${errorMessage}`);
                        }
                        return;
                    case 'fetchComments':
                        try {
                            const threads = await this.client.getCommentThreads(this.pullRequest.pullRequestId);
                            this.commentThreads = threads;
                            this.panel.webview.postMessage({
                                command: 'commentsLoaded',
                                threads: threads
                            });
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                            this.panel.webview.postMessage({
                                command: 'commentsError',
                                error: errorMessage
                            });
                        }
                        return;
                    case 'createComment':
                        try {
                            const newThread = await this.client.createCommentThread(
                                this.pullRequest.pullRequestId,
                                message.content,
                                message.filePath,
                                message.line,
                                message.side
                            );
                            this.commentThreads.push(newThread);
                            this.panel.webview.postMessage({
                                command: 'commentCreated',
                                thread: newThread,
                                fileIndex: message.fileIndex
                            });
                            vscode.window.showInformationMessage('Comment added');
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                            this.panel.webview.postMessage({
                                command: 'commentError',
                                error: errorMessage
                            });
                            vscode.window.showErrorMessage(`Failed to add comment: ${errorMessage}`);
                        }
                        return;
                    case 'replyComment':
                        try {
                            const reply = await this.client.replyToThread(
                                this.pullRequest.pullRequestId,
                                message.threadId,
                                message.content
                            );
                            // Update local thread with the new reply
                            const thread = this.commentThreads.find(t => t.id === message.threadId);
                            if (thread) {
                                thread.comments.push(reply);
                            }
                            this.panel.webview.postMessage({
                                command: 'replyCreated',
                                threadId: message.threadId,
                                comment: reply
                            });
                            vscode.window.showInformationMessage('Reply added');
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                            this.panel.webview.postMessage({
                                command: 'replyError',
                                threadId: message.threadId,
                                error: errorMessage
                            });
                            vscode.window.showErrorMessage(`Failed to add reply: ${errorMessage}`);
                        }
                        return;
                    case 'updateCommentStatus':
                        try {
                            const updatedThread = await this.client.updateCommentThreadStatus(
                                this.pullRequest.pullRequestId,
                                message.threadId,
                                message.status
                            );
                            // Update local thread with the new status
                            const threadToUpdate = this.commentThreads.find(t => t.id === message.threadId);
                            if (threadToUpdate) {
                                threadToUpdate.status = updatedThread.status;
                            }
                            this.panel.webview.postMessage({
                                command: 'statusUpdated',
                                threadId: message.threadId,
                                status: updatedThread.status
                            });
                            vscode.window.showInformationMessage(`Comment status changed to ${updatedThread.status}`);
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                            this.panel.webview.postMessage({
                                command: 'statusError',
                                threadId: message.threadId,
                                error: errorMessage
                            });
                            vscode.window.showErrorMessage(`Failed to update status: ${errorMessage}`);
                        }
                        return;
                }
            },
            null,
            this.disposables
        );
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        client: AzureDevOpsClient,
        pullRequest: PullRequest,
        organizationUrl: string,
        project: string,
        repository: string
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (PullRequestWebviewPanel.currentPanel) {
            PullRequestWebviewPanel.currentPanel.pullRequest = pullRequest;
            PullRequestWebviewPanel.currentPanel.update();
            PullRequestWebviewPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'azureDevOpsPR',
            `PR #${pullRequest.pullRequestId}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        PullRequestWebviewPanel.currentPanel = new PullRequestWebviewPanel(
            panel,
            client,
            pullRequest,
            organizationUrl,
            project,
            repository
        );
    }

    public dispose() {
        PullRequestWebviewPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private async update() {
        const webview = this.panel.webview;
        this.panel.title = `PR #${this.pullRequest.pullRequestId}`;

        try {
            // Fetch the latest pipelines, file list, and current user
            const [pipelines, fileListResult, currentUser] = await Promise.all([
                this.client.getPullRequestPipelines(this.pullRequest.pullRequestId),
                this.client.getPullRequestFileList(this.pullRequest.pullRequestId),
                this.client.getCurrentUser().catch(() => undefined)
            ]);

            this.currentUser = currentUser;

            // Store refs for on-demand diff fetching
            this.sourceRef = fileListResult.sourceRef;
            this.targetRef = fileListResult.targetRef;

            webview.html = this.getHtmlForWebview(webview, this.pullRequest, pipelines, fileListResult.files);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            webview.html = this.getErrorHtml(errorMessage);
        }
    }

    private getErrorHtml(error: string): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Error</title>
        </head>
        <body>
            <h1>Error Loading Pull Request</h1>
            <p>${error}</p>
        </body>
        </html>`;
    }

    private getHtmlForWebview(webview: vscode.Webview, pr: PullRequest, pipelines: PipelineRun[], files: FileInfo[]): string {
        const sourceBranch = pr.sourceRefName.replace('refs/heads/', '');
        const targetBranch = pr.targetRefName.replace('refs/heads/', '');

        // Construct the web URL for the pull request
        const prWebUrl = `${this.organizationUrl}/${this.project}/_git/${this.repository}/pullrequest/${pr.pullRequestId}`;

        // Prepare file data for lazy loading - content will be fetched on demand
        const fileData = files.map((file, index) => ({
            id: `diff-editor-${index}`,
            path: file.path,
            changeType: file.changeType,
            language: this.getLanguageFromPath(file.path),
            loaded: false,
            originalContent: '',
            modifiedContent: '',
            threads: [] as CommentThread[]
        }));

        // Generate a nonce for CSP
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; worker-src blob:; img-src ${webview.cspSource} https: data:; connect-src https://cdn.jsdelivr.net;">
            <title>Pull Request #${pr.pullRequestId}</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                    line-height: 1.6;
                }
                h1, h2 {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 10px;
                }
                .metadata {
                    display: grid;
                    grid-template-columns: 150px 1fr;
                    gap: 10px;
                    margin: 20px 0;
                    padding: 15px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 5px;
                }
                .metadata-label {
                    font-weight: bold;
                    color: var(--vscode-descriptionForeground);
                }
                .status-badge {
                    display: inline-block;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: bold;
                }
                .status-active {
                    background-color: var(--vscode-charts-green);
                    color: white;
                }
                .status-completed {
                    background-color: var(--vscode-charts-blue);
                    color: white;
                }
                .status-abandoned {
                    background-color: var(--vscode-charts-gray);
                    color: white;
                }
                .description {
                    margin: 20px 0;
                    padding: 15px;
                    background-color: var(--vscode-textBlockQuote-background);
                    border-left: 4px solid var(--vscode-textBlockQuote-border);
                    white-space: pre-wrap;
                }
                .latest-pipeline {
                    margin: 20px 0;
                    padding: 20px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 8px;
                    border: 2px solid var(--vscode-panel-border);
                }
                .latest-pipeline h2 {
                    margin-top: 0;
                    margin-bottom: 15px;
                    font-size: 18px;
                }
                .pipeline-item {
                    padding: 20px;
                    background-color: var(--vscode-editor-background);
                    border-radius: 6px;
                    border-left: 6px solid var(--vscode-panel-border);
                }
                .pipeline-item.succeeded {
                    border-left-color: var(--vscode-charts-green);
                }
                .pipeline-item.failed {
                    border-left-color: var(--vscode-charts-red);
                }
                .pipeline-item.inprogress {
                    border-left-color: var(--vscode-charts-yellow);
                }
                .pipeline-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }
                .pipeline-name {
                    font-weight: bold;
                    font-size: 18px;
                }
                .pipeline-status {
                    padding: 6px 12px;
                    border-radius: 6px;
                    font-size: 13px;
                    font-weight: bold;
                    text-transform: uppercase;
                }
                .pipeline-status.succeeded {
                    background-color: var(--vscode-charts-green);
                    color: white;
                }
                .pipeline-status.failed {
                    background-color: var(--vscode-charts-red);
                    color: white;
                }
                .pipeline-status.inprogress {
                    background-color: var(--vscode-charts-yellow);
                    color: black;
                }
                .pipeline-details {
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 12px;
                }
                a.button {
                    line-height: normal;
                }
                .button {
                    display: inline-block;
                    margin-top: 10px;
                    padding: 8px 16px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    text-decoration: none;
                    border-radius: 4px;
                    font-size: 13px;
                }
                .button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                button.button {
                    border: none;
                    cursor: pointer;
                    font-family: var(--vscode-font-family);
                }
                .branches {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    font-family: monospace;
                    margin: 10px 0;
                }
                .branch {
                    padding: 4px 8px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 4px;
                }
                .changes {
                    margin-top: 30px;
                }
                .diff-file {
                    margin: 20px 0;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    overflow: hidden;
                }
                .diff-file-header {
                    padding: 12px 15px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    cursor: pointer;
                }
                .diff-file-header:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .diff-file-header.add {
                    border-left: 4px solid var(--vscode-charts-green);
                }
                .diff-file-header.edit {
                    border-left: 4px solid var(--vscode-charts-blue);
                }
                .diff-file-header.delete {
                    border-left: 4px solid var(--vscode-charts-red);
                }
                .change-type {
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                    text-transform: uppercase;
                    min-width: 60px;
                    text-align: center;
                }
                .change-type.add {
                    background-color: var(--vscode-charts-green);
                    color: white;
                }
                .change-type.edit {
                    background-color: var(--vscode-charts-blue);
                    color: white;
                }
                .change-type.delete {
                    background-color: var(--vscode-charts-red);
                    color: white;
                }
                .change-type.rename {
                    background-color: var(--vscode-charts-yellow);
                    color: black;
                }
                .change-path {
                    font-family: monospace;
                    font-size: 13px;
                    flex: 1;
                    word-break: break-all;
                }
                .collapse-icon {
                    font-size: 12px;
                    transition: transform 0.2s;
                }
                .collapse-icon.collapsed {
                    transform: rotate(-90deg);
                }
                .diff-editor-container {
                    height: 400px;
                    border-top: 1px solid var(--vscode-panel-border);
                }
                .diff-editor-container.collapsed {
                    display: none;
                }
                .comment-threads-container.collapsed {
                    display: none;
                }
                .no-changes {
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                    padding: 20px;
                    text-align: center;
                }
                .loading {
                    padding: 20px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                }
                .reviewers-section {
                    margin: 20px 0;
                    padding: 20px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 8px;
                    border: 2px solid var(--vscode-panel-border);
                }
                .reviewers-section h2 {
                    margin-top: 0;
                    margin-bottom: 15px;
                    font-size: 18px;
                }
                .reviewers-list {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .reviewer-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 15px;
                    background-color: var(--vscode-editor-background);
                    border-radius: 6px;
                    border-left: 4px solid var(--vscode-panel-border);
                }
                .reviewer-item.approved {
                    border-left-color: var(--vscode-charts-green);
                }
                .reviewer-item.approved-suggestions {
                    border-left-color: #8BC34A;
                }
                .reviewer-item.waiting {
                    border-left-color: var(--vscode-charts-yellow);
                }
                .reviewer-item.rejected {
                    border-left-color: var(--vscode-charts-red);
                }
                .reviewer-item.current-user {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .reviewer-info {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .reviewer-name {
                    font-weight: 500;
                }
                .required-badge {
                    font-size: 10px;
                    padding: 2px 6px;
                    background-color: var(--vscode-charts-orange);
                    color: white;
                    border-radius: 3px;
                    text-transform: uppercase;
                }
                .vote-badge {
                    padding: 4px 10px;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 500;
                }
                .vote-badge.approved {
                    background-color: var(--vscode-charts-green);
                    color: white;
                }
                .vote-badge.approved-suggestions {
                    background-color: #8BC34A;
                    color: white;
                }
                .vote-badge.no-vote {
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                }
                .vote-badge.waiting {
                    background-color: var(--vscode-charts-yellow);
                    color: black;
                }
                .vote-badge.rejected {
                    background-color: var(--vscode-charts-red);
                    color: white;
                }
                .no-reviewers {
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                    padding: 10px;
                    text-align: center;
                }
                .voting-section {
                    margin-top: 15px;
                    padding-top: 15px;
                    border-top: 1px solid var(--vscode-panel-border);
                }
                .voting-section h3 {
                    margin: 0 0 10px 0;
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                }
                .voting-buttons {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                }
                .vote-btn {
                    padding: 8px 16px;
                    border: none;
                    border-radius: 4px;
                    font-size: 13px;
                    cursor: pointer;
                    font-family: var(--vscode-font-family);
                    transition: opacity 0.2s;
                }
                .vote-btn:hover {
                    opacity: 0.85;
                }
                .vote-btn.approve {
                    background-color: var(--vscode-charts-green);
                    color: white;
                }
                .vote-btn.approve-suggestions {
                    background-color: #8BC34A;
                    color: white;
                }
                .vote-btn.waiting {
                    background-color: var(--vscode-charts-yellow);
                    color: black;
                }
                .vote-btn.reject {
                    background-color: var(--vscode-charts-red);
                    color: white;
                }
                .vote-btn.reset {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                /* Comment styles */
                .comment-threads-container {
                    padding: 10px 15px;
                    background-color: var(--vscode-editor-background);
                    border-top: 1px solid var(--vscode-panel-border);
                }
                .comment-thread {
                    margin: 10px 0;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    overflow: hidden;
                }
                .comment-thread.resolved {
                    opacity: 0.7;
                }
                .comment-thread-header {
                    padding: 8px 12px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }
                .comment-line-info {
                    font-family: monospace;
                }
                .comment-status {
                    padding: 2px 8px;
                    border-radius: 3px;
                    font-size: 11px;
                    text-transform: uppercase;
                }
                .comment-status.active {
                    background-color: var(--vscode-charts-blue);
                    color: white;
                }
                .comment-status.resolved {
                    background-color: var(--vscode-charts-green);
                    color: white;
                }
                .status-dropdown {
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    border: 1px solid var(--vscode-dropdown-border);
                    background-color: var(--vscode-dropdown-background);
                    color: var(--vscode-dropdown-foreground);
                    cursor: pointer;
                    text-transform: uppercase;
                }
                .status-dropdown:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                }
                .status-dropdown:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }
                .comment-item {
                    padding: 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .comment-item:last-child {
                    border-bottom: none;
                }
                .comment-item.system {
                    background-color: var(--vscode-textBlockQuote-background);
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                }
                .comment-author {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                }
                .comment-author-name {
                    font-weight: 600;
                    color: var(--vscode-foreground);
                }
                .comment-date {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                }
                .comment-content {
                    white-space: pre-wrap;
                    word-wrap: break-word;
                    line-height: 1.5;
                }
                .comment-input-container {
                    padding: 12px;
                    background-color: var(--vscode-input-background);
                    border-top: 1px solid var(--vscode-panel-border);
                }
                .comment-input-container.inline {
                    margin: 10px 0;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                }
                .comment-textarea {
                    width: 100%;
                    min-height: 80px;
                    padding: 10px;
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    resize: vertical;
                    box-sizing: border-box;
                }
                .comment-textarea:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                }
                .comment-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 8px;
                    margin-top: 10px;
                }
                .comment-btn {
                    padding: 6px 14px;
                    border: none;
                    border-radius: 4px;
                    font-size: 12px;
                    cursor: pointer;
                    font-family: var(--vscode-font-family);
                }
                .comment-btn.primary {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .comment-btn.primary:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .comment-btn.primary:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .comment-btn.secondary {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .comment-btn.secondary:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
                .add-comment-hint {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    padding: 8px 12px;
                    text-align: center;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                }
                .no-comments {
                    padding: 15px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }
                .comment-indicator {
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    background-color: var(--vscode-charts-blue);
                    border-radius: 50%;
                    margin-left: 8px;
                    font-size: 10px;
                    color: white;
                    text-align: center;
                    line-height: 14px;
                }
                /* General PR comments section */
                .general-comments-section {
                    margin: 20px 0;
                    padding: 20px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 8px;
                    border: 2px solid var(--vscode-panel-border);
                }
                .general-comments-section h2 {
                    margin-top: 0;
                    margin-bottom: 15px;
                    font-size: 18px;
                }
                .general-comments-list {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .general-comment-thread {
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    overflow: hidden;
                }
                .general-comment-thread.resolved {
                    opacity: 0.7;
                }
                .general-comment-header {
                    padding: 8px 12px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }
                .no-general-comments {
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                    padding: 10px;
                    text-align: center;
                }
                .add-general-comment-container {
                    margin-top: 15px;
                    padding-top: 15px;
                    border-top: 1px solid var(--vscode-panel-border);
                }
                .add-general-comment-container h3 {
                    margin: 0 0 10px 0;
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            <h1>${this.escapeHtml(pr.title)}</h1>

            <div class="metadata">
                <span class="metadata-label">Status:</span>
                <span><span class="status-badge status-${pr.status.toLowerCase()}">${pr.status}</span></span>

                <span class="metadata-label">Pull Request ID:</span>
                <span>#${pr.pullRequestId}</span>

                <span class="metadata-label">Author:</span>
                <span>${this.escapeHtml(pr.createdBy.displayName)} (${this.escapeHtml(pr.createdBy.uniqueName)})</span>

                <span class="metadata-label">Created:</span>
                <span>${new Date(pr.creationDate).toLocaleString()}</span>

                <span class="metadata-label">Branches:</span>
                <div class="branches">
                    <span class="branch">${this.escapeHtml(sourceBranch)}</span>
                    <span>→</span>
                    <span class="branch">${this.escapeHtml(targetBranch)}</span>
                </div>
            </div>

            ${pipelines.length > 0 ? `
            <div class="latest-pipeline">
                <h2>Latest Pipeline</h2>
                ${this.getLatestPipelineHtml(pipelines[0])}
            </div>
            ` : ''}

            <a href="${prWebUrl}" class="button">Open in Azure DevOps</a>
            <button class="button" id="copy-link-btn">Copy Link</button>

            ${pr.description ? `
            <h2>Description</h2>
            <div class="description">${this.escapeHtml(pr.description)}</div>
            ` : ''}

            <div class="reviewers-section">
                <h2>Reviewers</h2>
                ${this.getReviewersHtml(pr.reviewers, this.currentUser?.id)}
                <div class="voting-section">
                    <h3>Cast Your Vote</h3>
                    ${this.getVotingButtonsHtml()}
                </div>
            </div>

            <div class="general-comments-section">
                <h2>General Comments</h2>
                <div id="general-comments-list" class="general-comments-list">
                    <div class="no-general-comments">Loading comments...</div>
                </div>
                <div class="add-general-comment-container">
                    <h3>Add a Comment</h3>
                    <div class="comment-input-container" style="padding: 0; background: transparent; border: none;">
                        <textarea class="comment-textarea" placeholder="Write a general comment on this PR..." id="general-comment-textarea"></textarea>
                        <div class="comment-actions">
                            <button class="comment-btn primary" id="submit-general-comment-btn">Comment</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="changes">
                <h2>File Changes (${files.length})</h2>
                ${files.length > 0 ? files.map((file, index) => this.getFileContainerHtml(file, index)).join('') :
                '<div class="no-changes">No file changes found for this pull request</div>'}
            </div>

            <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                const fileData = ${JSON.stringify(fileData)};
                const editors = {};
                const pendingLoads = {};
                let allThreads = [];
                let activeCommentInput = null;

                function copyLink() {
                    vscode.postMessage({
                        command: 'copyLink',
                        url: '${prWebUrl}'
                    });
                }

                function toggleDiff(index) {
                    const container = document.getElementById('diff-editor-' + index);
                    const commentsContainer = document.getElementById('comment-threads-' + index);
                    const icon = document.getElementById('collapse-icon-' + index);
                    if (container.classList.contains('collapsed')) {
                        container.classList.remove('collapsed');
                        if (commentsContainer) commentsContainer.classList.remove('collapsed');
                        icon.classList.remove('collapsed');
                        // Request diff content if not already loaded
                        if (!fileData[index].loaded && !pendingLoads[index]) {
                            requestDiff(index);
                        } else if (fileData[index].loaded && !editors[index]) {
                            initializeEditor(index);
                        }
                    } else {
                        container.classList.add('collapsed');
                        if (commentsContainer) commentsContainer.classList.add('collapsed');
                        icon.classList.add('collapsed');
                    }
                }

                function requestDiff(index) {
                    const data = fileData[index];
                    const container = document.getElementById(data.id);
                    if (container) {
                        container.innerHTML = '<div class="loading">Loading diff...</div>';
                    }
                    pendingLoads[index] = true;
                    vscode.postMessage({
                        command: 'fetchDiff',
                        index: index,
                        filePath: data.path,
                        changeType: data.changeType
                    });
                }

                // Get threads for a specific file
                function getThreadsForFile(filePath) {
                    return allThreads.filter(t =>
                        t.threadContext && t.threadContext.filePath === filePath && !t.isDeleted
                    );
                }

                // Get general PR threads (not linked to any file)
                // Filter out system-only threads (like vote changes) - only show threads with at least one non-system comment
                function getGeneralThreads() {
                    return allThreads.filter(t =>
                        !t.threadContext && !t.isDeleted &&
                        t.comments && t.comments.some(c => !c.isDeleted && c.commentType !== 'system')
                    );
                }

                // Render comment threads for a file
                function renderCommentThreads(index) {
                    const data = fileData[index];
                    const threadsContainer = document.getElementById('comment-threads-' + index);
                    if (!threadsContainer) return;

                    const threads = getThreadsForFile(data.path);
                    fileData[index].threads = threads;

                    if (threads.length === 0) {
                        threadsContainer.innerHTML = '<div class="no-comments">No comments on this file. Click on a line number in the diff to add a comment.</div>';
                        return;
                    }

                    let html = '';
                    threads.forEach(thread => {
                        const lineInfo = thread.threadContext.rightFileStart
                            ? 'Line ' + thread.threadContext.rightFileStart.line + ' (modified)'
                            : thread.threadContext.leftFileStart
                                ? 'Line ' + thread.threadContext.leftFileStart.line + ' (original)'
                                : 'File comment';

                        const threadClass = thread.status === 'active' ? '' : ' resolved';

                        html += '<div class="comment-thread' + threadClass + '" data-thread-id="' + thread.id + '">';
                        html += '<div class="comment-thread-header">';
                        html += '<span class="comment-line-info">' + lineInfo + '</span>';
                        html += '<select class="status-dropdown" data-thread-id="' + thread.id + '" onchange="updateThreadStatus(' + thread.id + ', this.value)">';
                        html += '<option value="active"' + (thread.status === 'active' ? ' selected' : '') + '>Active</option>';
                        html += '<option value="fixed"' + (thread.status === 'fixed' ? ' selected' : '') + '>Fixed</option>';
                        html += '<option value="wontFix"' + (thread.status === 'wontFix' ? ' selected' : '') + '>Won\\'t Fix</option>';
                        html += '<option value="closed"' + (thread.status === 'closed' ? ' selected' : '') + '>Closed</option>';
                        html += '<option value="byDesign"' + (thread.status === 'byDesign' ? ' selected' : '') + '>By Design</option>';
                        html += '<option value="pending"' + (thread.status === 'pending' ? ' selected' : '') + '>Pending</option>';
                        html += '</select>';
                        html += '</div>';

                        thread.comments.forEach(comment => {
                            if (comment.isDeleted) return;
                            const commentClass = comment.commentType === 'system' ? ' system' : '';
                            html += '<div class="comment-item' + commentClass + '">';
                            html += '<div class="comment-author">';
                            html += '<span class="comment-author-name">' + escapeHtml(comment.author.displayName) + '</span>';
                            html += '<span class="comment-date">' + formatDate(comment.publishedDate) + '</span>';
                            html += '</div>';
                            html += '<div class="comment-content">' + escapeHtml(comment.content) + '</div>';
                            html += '</div>';
                        });

                        // Reply input area
                        html += '<div class="comment-input-container" id="reply-input-' + thread.id + '">';
                        html += '<textarea class="comment-textarea" placeholder="Write a reply..." id="reply-textarea-' + thread.id + '"></textarea>';
                        html += '<div class="comment-actions">';
                        html += '<button class="comment-btn secondary" onclick="cancelReply(' + thread.id + ')">Cancel</button>';
                        html += '<button class="comment-btn primary" onclick="submitReply(' + thread.id + ')">Reply</button>';
                        html += '</div>';
                        html += '</div>';

                        html += '</div>';
                    });

                    threadsContainer.innerHTML = html;
                }

                // Render general PR comment threads (not linked to files)
                function renderGeneralComments() {
                    const container = document.getElementById('general-comments-list');
                    if (!container) return;

                    const threads = getGeneralThreads();

                    if (threads.length === 0) {
                        container.innerHTML = '<div class="no-general-comments">No general comments on this PR yet.</div>';
                        return;
                    }

                    let html = '';
                    threads.forEach(thread => {
                        const threadClass = thread.status === 'active' ? '' : ' resolved';

                        html += '<div class="general-comment-thread' + threadClass + '" data-thread-id="' + thread.id + '">';
                        html += '<div class="general-comment-header">';
                        html += '<span>General comment</span>';
                        html += '<select class="status-dropdown" data-thread-id="' + thread.id + '" onchange="updateThreadStatus(' + thread.id + ', this.value)">';
                        html += '<option value="active"' + (thread.status === 'active' ? ' selected' : '') + '>Active</option>';
                        html += '<option value="fixed"' + (thread.status === 'fixed' ? ' selected' : '') + '>Fixed</option>';
                        html += '<option value="wontFix"' + (thread.status === 'wontFix' ? ' selected' : '') + '>Won\\'t Fix</option>';
                        html += '<option value="closed"' + (thread.status === 'closed' ? ' selected' : '') + '>Closed</option>';
                        html += '<option value="byDesign"' + (thread.status === 'byDesign' ? ' selected' : '') + '>By Design</option>';
                        html += '<option value="pending"' + (thread.status === 'pending' ? ' selected' : '') + '>Pending</option>';
                        html += '</select>';
                        html += '</div>';

                        thread.comments.forEach(comment => {
                            if (comment.isDeleted) return;
                            const commentClass = comment.commentType === 'system' ? ' system' : '';
                            html += '<div class="comment-item' + commentClass + '">';
                            html += '<div class="comment-author">';
                            html += '<span class="comment-author-name">' + escapeHtml(comment.author.displayName) + '</span>';
                            html += '<span class="comment-date">' + formatDate(comment.publishedDate) + '</span>';
                            html += '</div>';
                            html += '<div class="comment-content">' + escapeHtml(comment.content) + '</div>';
                            html += '</div>';
                        });

                        // Reply input area
                        html += '<div class="comment-input-container" id="reply-input-' + thread.id + '">';
                        html += '<textarea class="comment-textarea" placeholder="Write a reply..." id="reply-textarea-' + thread.id + '"></textarea>';
                        html += '<div class="comment-actions">';
                        html += '<button class="comment-btn secondary" onclick="cancelReply(' + thread.id + ')">Cancel</button>';
                        html += '<button class="comment-btn primary" onclick="submitReply(' + thread.id + ')">Reply</button>';
                        html += '</div>';
                        html += '</div>';

                        html += '</div>';
                    });

                    container.innerHTML = html;
                }

                // Submit a general PR comment (not linked to a file)
                function submitGeneralComment() {
                    const textarea = document.getElementById('general-comment-textarea');
                    const content = textarea.value.trim();
                    if (!content) return;

                    const submitBtn = document.getElementById('submit-general-comment-btn');
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Submitting...';

                    vscode.postMessage({
                        command: 'createComment',
                        content: content,
                        filePath: null,
                        line: null,
                        side: null,
                        fileIndex: null
                    });
                }

                // Show inline comment input for a specific line
                function showCommentInput(index, lineNumber, side) {
                    // Remove any existing comment input
                    if (activeCommentInput) {
                        activeCommentInput.remove();
                        activeCommentInput = null;
                    }

                    const data = fileData[index];
                    const inputHtml = '<div class="comment-input-container inline" id="inline-comment-input">' +
                        '<div style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px;">' +
                        'Adding comment on line ' + lineNumber + ' (' + (side === 'right' ? 'modified' : 'original') + ')' +
                        '</div>' +
                        '<textarea class="comment-textarea" placeholder="Write your comment..." id="new-comment-textarea"></textarea>' +
                        '<div class="comment-actions">' +
                        '<button class="comment-btn secondary" onclick="cancelNewComment()">Cancel</button>' +
                        '<button class="comment-btn primary" onclick="submitNewComment(' + index + ', ' + lineNumber + ', \\'' + side + '\\')">Comment</button>' +
                        '</div>' +
                        '</div>';

                    const threadsContainer = document.getElementById('comment-threads-' + index);
                    if (threadsContainer) {
                        threadsContainer.insertAdjacentHTML('afterbegin', inputHtml);
                        activeCommentInput = document.getElementById('inline-comment-input');
                        document.getElementById('new-comment-textarea').focus();
                    }
                }

                function cancelNewComment() {
                    if (activeCommentInput) {
                        activeCommentInput.remove();
                        activeCommentInput = null;
                    }
                }

                function submitNewComment(index, lineNumber, side) {
                    const textarea = document.getElementById('new-comment-textarea');
                    const content = textarea.value.trim();
                    if (!content) return;

                    const data = fileData[index];
                    const submitBtn = activeCommentInput.querySelector('.comment-btn.primary');
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Submitting...';

                    vscode.postMessage({
                        command: 'createComment',
                        content: content,
                        filePath: data.path,
                        line: lineNumber,
                        side: side,
                        fileIndex: index
                    });
                }

                function cancelReply(threadId) {
                    const textarea = document.getElementById('reply-textarea-' + threadId);
                    if (textarea) {
                        textarea.value = '';
                    }
                }

                function submitReply(threadId) {
                    const textarea = document.getElementById('reply-textarea-' + threadId);
                    const content = textarea.value.trim();
                    if (!content) return;

                    const container = document.getElementById('reply-input-' + threadId);
                    const submitBtn = container.querySelector('.comment-btn.primary');
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Submitting...';

                    vscode.postMessage({
                        command: 'replyComment',
                        threadId: threadId,
                        content: content
                    });
                }

                function updateThreadStatus(threadId, newStatus) {
                    // Disable the dropdown while updating
                    const dropdown = document.querySelector('select.status-dropdown[data-thread-id="' + threadId + '"]');
                    if (dropdown) {
                        dropdown.disabled = true;
                    }

                    vscode.postMessage({
                        command: 'updateCommentStatus',
                        threadId: threadId,
                        status: newStatus
                    });
                }

                function escapeHtml(text) {
                    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
                    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
                }

                function formatDate(dateStr) {
                    if (!dateStr) return '';
                    const date = new Date(dateStr);
                    return date.toLocaleString();
                }

                // Handle messages from the extension
                window.addEventListener('message', function(event) {
                    const message = event.data;
                    switch (message.command) {
                        case 'diffLoaded': {
                            const index = message.index;
                            fileData[index].originalContent = message.diff.originalContent;
                            fileData[index].modifiedContent = message.diff.modifiedContent;
                            fileData[index].loaded = true;
                            delete pendingLoads[index];
                            initializeEditor(index);
                            break;
                        }
                        case 'diffError': {
                            const errorIndex = message.index;
                            delete pendingLoads[errorIndex];
                            const errorContainer = document.getElementById(fileData[errorIndex].id);
                            if (errorContainer) {
                                errorContainer.innerHTML = '<div class="loading" style="color: var(--vscode-errorForeground);">Error loading diff: ' + message.error + '</div>';
                            }
                            break;
                        }
                        case 'commentsLoaded': {
                            allThreads = message.threads;
                            // Render general PR comments
                            renderGeneralComments();
                            // Update all loaded file comment sections
                            fileData.forEach((data, index) => {
                                if (data.loaded) {
                                    renderCommentThreads(index);
                                    updateEditorDecorations(index);
                                }
                            });
                            break;
                        }
                        case 'commentCreated': {
                            allThreads.push(message.thread);
                            cancelNewComment();
                            if (message.fileIndex !== null && message.fileIndex !== undefined) {
                                renderCommentThreads(message.fileIndex);
                                updateEditorDecorations(message.fileIndex);
                            } else {
                                // General comment - clear the textarea and re-render general comments
                                const textarea = document.getElementById('general-comment-textarea');
                                if (textarea) textarea.value = '';
                                const submitBtn = document.getElementById('submit-general-comment-btn');
                                if (submitBtn) {
                                    submitBtn.disabled = false;
                                    submitBtn.textContent = 'Comment';
                                }
                                renderGeneralComments();
                            }
                            break;
                        }
                        case 'replyCreated': {
                            const thread = allThreads.find(t => t.id === message.threadId);
                            if (thread) {
                                thread.comments.push(message.comment);
                            }
                            // Check if this is a general comment thread (no threadContext)
                            const isGeneralThread = thread && !thread.threadContext;
                            if (isGeneralThread) {
                                renderGeneralComments();
                            } else {
                                // Find which file this thread belongs to and re-render
                                fileData.forEach((data, index) => {
                                    const threads = getThreadsForFile(data.path);
                                    if (threads.find(t => t.id === message.threadId)) {
                                        renderCommentThreads(index);
                                    }
                                });
                            }
                            break;
                        }
                        case 'commentError':
                        case 'replyError': {
                            // Re-enable buttons
                            document.querySelectorAll('.comment-btn.primary:disabled').forEach(btn => {
                                btn.disabled = false;
                                btn.textContent = btn.closest('#inline-comment-input') ? 'Comment' : 'Reply';
                            });
                            break;
                        }
                        case 'statusUpdated': {
                            const thread = allThreads.find(t => t.id === message.threadId);
                            if (thread) {
                                thread.status = message.status;
                            }
                            // Re-enable dropdown
                            const dropdown = document.querySelector('select.status-dropdown[data-thread-id="' + message.threadId + '"]');
                            if (dropdown) {
                                dropdown.disabled = false;
                                dropdown.value = message.status;
                            }
                            // Update thread visual state (resolved opacity)
                            const threadElement = document.querySelector('.comment-thread[data-thread-id="' + message.threadId + '"], .general-comment-thread[data-thread-id="' + message.threadId + '"]');
                            if (threadElement) {
                                if (message.status === 'active') {
                                    threadElement.classList.remove('resolved');
                                } else {
                                    threadElement.classList.add('resolved');
                                }
                            }
                            break;
                        }
                        case 'statusError': {
                            // Re-enable dropdown and revert to previous value
                            const thread = allThreads.find(t => t.id === message.threadId);
                            const dropdown = document.querySelector('select.status-dropdown[data-thread-id="' + message.threadId + '"]');
                            if (dropdown) {
                                dropdown.disabled = false;
                                if (thread) {
                                    dropdown.value = thread.status;
                                }
                            }
                            break;
                        }
                    }
                });

                // Update Monaco editor decorations to show comment indicators
                function updateEditorDecorations(index) {
                    const editor = editors[index];
                    if (!editor) return;

                    const data = fileData[index];
                    const threads = getThreadsForFile(data.path);

                    // Get both editors
                    const originalEditor = editor.getOriginalEditor();
                    const modifiedEditor = editor.getModifiedEditor();

                    // Decorations for original (left) side
                    const originalDecorations = [];
                    // Decorations for modified (right) side
                    const modifiedDecorations = [];

                    threads.forEach(thread => {
                        if (thread.threadContext) {
                            if (thread.threadContext.leftFileStart) {
                                originalDecorations.push({
                                    range: new monaco.Range(
                                        thread.threadContext.leftFileStart.line,
                                        1,
                                        thread.threadContext.leftFileStart.line,
                                        1
                                    ),
                                    options: {
                                        isWholeLine: true,
                                        glyphMarginClassName: 'comment-glyph',
                                        glyphMarginHoverMessage: { value: 'Click to view/add comments' }
                                    }
                                });
                            }
                            if (thread.threadContext.rightFileStart) {
                                modifiedDecorations.push({
                                    range: new monaco.Range(
                                        thread.threadContext.rightFileStart.line,
                                        1,
                                        thread.threadContext.rightFileStart.line,
                                        1
                                    ),
                                    options: {
                                        isWholeLine: true,
                                        glyphMarginClassName: 'comment-glyph',
                                        glyphMarginHoverMessage: { value: 'Click to view/add comments' }
                                    }
                                });
                            }
                        }
                    });

                    // Apply decorations
                    if (originalEditor) {
                        originalEditor.deltaDecorations([], originalDecorations);
                    }
                    if (modifiedEditor) {
                        modifiedEditor.deltaDecorations([], modifiedDecorations);
                    }
                }

                function initializeEditor(index) {
                    const data = fileData[index];
                    const container = document.getElementById(data.id);

                    if (!container) {
                        console.error('Container not found for index', index);
                        return;
                    }

                    if (!data.loaded) {
                        console.error('Data not loaded for index', index);
                        return;
                    }

                    try {
                        require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
                        require(['vs/editor/editor.main'], function() {
                            try {
                                // Clear loading message
                                container.innerHTML = '';

                                // Detect VS Code theme
                                const isDark = document.body.classList.contains('vscode-dark') ||
                                               getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim().match(/^#[0-3]/);

                                // Add CSS for glyph margin
                                if (!document.getElementById('monaco-comment-styles')) {
                                    const style = document.createElement('style');
                                    style.id = 'monaco-comment-styles';
                                    style.textContent = '.comment-glyph { background-color: var(--vscode-charts-blue); border-radius: 50%; cursor: pointer; }';
                                    document.head.appendChild(style);
                                }

                                const editor = monaco.editor.createDiffEditor(container, {
                                    readOnly: true,
                                    renderSideBySide: true,
                                    automaticLayout: true,
                                    theme: isDark ? 'vs-dark' : 'vs',
                                    scrollBeyondLastLine: false,
                                    minimap: { enabled: false },
                                    lineNumbers: 'on',
                                    glyphMargin: true,
                                    folding: false,
                                    lineDecorationsWidth: 10,
                                    lineNumbersMinChars: 3
                                });

                                const originalModel = monaco.editor.createModel(data.originalContent, data.language);
                                const modifiedModel = monaco.editor.createModel(data.modifiedContent, data.language);

                                editor.setModel({
                                    original: originalModel,
                                    modified: modifiedModel
                                });

                                editors[index] = editor;

                                // Add click handlers for glyph margin (to add comments)
                                const originalEditor = editor.getOriginalEditor();
                                const modifiedEditor = editor.getModifiedEditor();

                                originalEditor.onMouseDown(function(e) {
                                    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
                                        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
                                        const lineNumber = e.target.position.lineNumber;
                                        showCommentInput(index, lineNumber, 'left');
                                    }
                                });

                                modifiedEditor.onMouseDown(function(e) {
                                    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
                                        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
                                        const lineNumber = e.target.position.lineNumber;
                                        showCommentInput(index, lineNumber, 'right');
                                    }
                                });

                                // Adjust height based on content
                                const lineCount = Math.max(
                                    data.originalContent.split('\\n').length,
                                    data.modifiedContent.split('\\n').length
                                );
                                const height = Math.min(Math.max(lineCount * 19 + 20, 100), 600);
                                container.style.height = height + 'px';
                                editor.layout();

                                // Render comments for this file
                                renderCommentThreads(index);
                                updateEditorDecorations(index);
                            } catch (err) {
                                console.error('Error creating Monaco editor:', err);
                                container.innerHTML = '<div class="loading" style="color: red;">Error loading diff editor: ' + err.message + '</div>';
                            }
                        }, function(err) {
                            console.error('Error loading Monaco modules:', err);
                            container.innerHTML = '<div class="loading" style="color: red;">Error loading Monaco: ' + (err.message || err) + '</div>';
                        });
                    } catch (err) {
                        console.error('Error initializing Monaco:', err);
                        container.innerHTML = '<div class="loading" style="color: red;">Error: ' + err.message + '</div>';
                    }
                }

                // Handle voting
                function vote(voteValue) {
                    vscode.postMessage({
                        command: 'vote',
                        vote: voteValue
                    });
                }

                // Set up event listeners when DOM is ready
                document.addEventListener('DOMContentLoaded', function() {
                    // Copy link button
                    const copyLinkBtn = document.getElementById('copy-link-btn');
                    if (copyLinkBtn) {
                        copyLinkBtn.addEventListener('click', copyLink);
                    }

                    // Voting buttons
                    document.querySelectorAll('.vote-btn').forEach(function(btn) {
                        btn.addEventListener('click', function() {
                            const voteValue = parseInt(btn.getAttribute('data-vote'), 10);
                            vote(voteValue);
                        });
                    });

                    // General comment submit button
                    const generalCommentBtn = document.getElementById('submit-general-comment-btn');
                    if (generalCommentBtn) {
                        generalCommentBtn.addEventListener('click', submitGeneralComment);
                    }

                    // Diff file headers - use event delegation
                    document.querySelectorAll('.diff-file-header').forEach(function(header) {
                        header.addEventListener('click', function() {
                            const index = parseInt(header.getAttribute('data-index'), 10);
                            toggleDiff(index);
                        });
                    });

                    // Auto-expand and request diffs for the first 3 files
                    for (let i = 0; i < Math.min(3, fileData.length); i++) {
                        const container = document.getElementById('diff-editor-' + i);
                        const commentsContainer = document.getElementById('comment-threads-' + i);
                        const icon = document.getElementById('collapse-icon-' + i);
                        if (container && container.classList.contains('collapsed')) {
                            container.classList.remove('collapsed');
                            icon.classList.remove('collapsed');
                        }
                        if (commentsContainer && commentsContainer.classList.contains('collapsed')) {
                            commentsContainer.classList.remove('collapsed');
                        }
                        requestDiff(i);
                    }

                    // Fetch comments for the PR
                    vscode.postMessage({ command: 'fetchComments' });
                });
            </script>
        </body>
        </html>`;
    }

    private getLanguageFromPath(filePath: string): string {
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const languageMap: { [key: string]: string } = {
            'ts': 'typescript',
            'tsx': 'typescript',
            'js': 'javascript',
            'jsx': 'javascript',
            'json': 'json',
            'html': 'html',
            'htm': 'html',
            'css': 'css',
            'scss': 'scss',
            'less': 'less',
            'md': 'markdown',
            'yaml': 'yaml',
            'yml': 'yaml',
            'xml': 'xml',
            'py': 'python',
            'java': 'java',
            'c': 'c',
            'cpp': 'cpp',
            'h': 'c',
            'hpp': 'cpp',
            'cs': 'csharp',
            'go': 'go',
            'rs': 'rust',
            'rb': 'ruby',
            'php': 'php',
            'sh': 'shell',
            'bash': 'shell',
            'sql': 'sql',
            'swift': 'swift',
            'kt': 'kotlin',
            'scala': 'scala',
            'r': 'r',
            'ps1': 'powershell',
            'psm1': 'powershell',
            'bat': 'bat',
            'cmd': 'bat'
        };
        return languageMap[ext] || 'plaintext';
    }

    private getFileContainerHtml(file: FileInfo, index: number): string {
        const changeType = file.changeType.toLowerCase();
        let changeTypeClass = changeType;
        let changeTypeLabel = changeType;

        if (changeType === 'add') {
            changeTypeClass = 'add';
            changeTypeLabel = 'add';
        } else if (changeType === 'edit') {
            changeTypeClass = 'edit';
            changeTypeLabel = 'edit';
        } else if (changeType === 'delete') {
            changeTypeClass = 'delete';
            changeTypeLabel = 'delete';
        } else if (changeType === 'rename') {
            changeTypeClass = 'rename';
            changeTypeLabel = 'rename';
        }

        return `
        <div class="diff-file">
            <div class="diff-file-header ${changeTypeClass}" data-index="${index}">
                <span class="collapse-icon collapsed" id="collapse-icon-${index}">▼</span>
                <span class="change-type ${changeTypeClass}">${changeTypeLabel}</span>
                <span class="change-path">${this.escapeHtml(file.path)}</span>
            </div>
            <div class="diff-editor-container collapsed" id="diff-editor-${index}">
                <div class="loading">Click to load diff...</div>
            </div>
            <div class="comment-threads-container collapsed" id="comment-threads-${index}">
                <div class="add-comment-hint">Click on a line number in the diff to add a comment</div>
            </div>
        </div>`;
    }

    private getLatestPipelineHtml(pipeline: PipelineRun): string {
        const statusClass = pipeline.state.toLowerCase().replace(/\s+/g, '');
        const result = pipeline.result.toLowerCase();
        const state = pipeline.state.toLowerCase();

        let statusBadge = '';
        let statusBadgeClass = '';
        if (state === 'completed') {
            statusBadge = result;
            statusBadgeClass = result;
        } else {
            statusBadge = state;
            statusBadgeClass = state;
        }

        return `
        <div class="pipeline-item ${statusClass}">
            <div class="pipeline-header">
                <span class="pipeline-name">${this.escapeHtml(pipeline.name)}</span>
                <span class="pipeline-status ${statusBadgeClass}">${statusBadge}</span>
            </div>
            <div class="pipeline-details">
                Started: ${new Date(pipeline.createdDate).toLocaleString()}
                ${pipeline.finishedDate ? `<br>Finished: ${new Date(pipeline.finishedDate).toLocaleString()}` : ''}
            </div>
            <a href="${pipeline.url}" class="button">View Pipeline</a>
        </div>`;
    }

    private getPipelineHtml(pipeline: PipelineRun): string {
        const statusClass = pipeline.state.toLowerCase().replace(/\s+/g, '');
        const result = pipeline.result.toLowerCase();
        const state = pipeline.state.toLowerCase();

        let statusBadge = '';
        if (state === 'completed') {
            statusBadge = result;
        } else {
            statusBadge = state;
        }

        return `
        <div class="pipeline-item ${statusClass}">
            <div class="pipeline-header">
                <span class="pipeline-name">${this.escapeHtml(pipeline.name)}</span>
                <span class="pipeline-status">${statusBadge}</span>
            </div>
            <div class="pipeline-details">
                Started: ${new Date(pipeline.createdDate).toLocaleString()}
                ${pipeline.finishedDate ? `<br>Finished: ${new Date(pipeline.finishedDate).toLocaleString()}` : ''}
            </div>
            <a href="${pipeline.url}" class="button">View Pipeline</a>
        </div>`;
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private getVoteMessage(vote: number): string {
        switch (vote) {
            case 10:
                return 'Pull request approved';
            case 5:
                return 'Pull request approved with suggestions';
            case 0:
                return 'Vote reset';
            case -5:
                return 'Marked as waiting for author';
            case -10:
                return 'Pull request rejected';
            default:
                return 'Vote submitted';
        }
    }

    private getVoteLabel(vote: number): string {
        switch (vote) {
            case 10:
                return 'Approved';
            case 5:
                return 'Approved with suggestions';
            case 0:
                return 'No vote';
            case -5:
                return 'Waiting for author';
            case -10:
                return 'Rejected';
            default:
                return 'Unknown';
        }
    }

    private getVoteClass(vote: number): string {
        if (vote >= 10) {
            return 'approved';
        } else if (vote > 0) {
            return 'approved-suggestions';
        } else if (vote === 0) {
            return 'no-vote';
        } else if (vote > -10) {
            return 'waiting';
        } else {
            return 'rejected';
        }
    }

    private getReviewersHtml(reviewers: Reviewer[], currentUserId: string | undefined): string {
        if (reviewers.length === 0) {
            return '<div class="no-reviewers">No reviewers assigned</div>';
        }

        const reviewerItems = reviewers.map(reviewer => {
            const voteClass = this.getVoteClass(reviewer.vote);
            const voteLabel = this.getVoteLabel(reviewer.vote);
            const isCurrentUser = currentUserId && reviewer.id === currentUserId;
            const requiredBadge = reviewer.isRequired ? '<span class="required-badge">Required</span>' : '';

            return `
            <div class="reviewer-item ${voteClass}${isCurrentUser ? ' current-user' : ''}">
                <div class="reviewer-info">
                    <span class="reviewer-name">${this.escapeHtml(reviewer.displayName)}</span>
                    ${requiredBadge}
                </div>
                <span class="vote-badge ${voteClass}">${voteLabel}</span>
            </div>`;
        }).join('');

        return `<div class="reviewers-list">${reviewerItems}</div>`;
    }

    private getVotingButtonsHtml(): string {
        return `
        <div class="voting-buttons">
            <button class="vote-btn approve" data-vote="10" title="Approve">Approve</button>
            <button class="vote-btn approve-suggestions" data-vote="5" title="Approve with suggestions">Approve with suggestions</button>
            <button class="vote-btn waiting" data-vote="-5" title="Wait for author">Wait for author</button>
            <button class="vote-btn reject" data-vote="-10" title="Reject">Reject</button>
            <button class="vote-btn reset" data-vote="0" title="Reset vote">Reset vote</button>
        </div>`;
    }
}
