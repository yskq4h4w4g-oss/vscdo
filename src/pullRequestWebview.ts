import * as vscode from 'vscode';
import { PullRequest, PipelineRun, AzureDevOpsClient } from './azureDevOpsClient';

export class PullRequestWebviewPanel {
    private static currentPanel: PullRequestWebviewPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private organizationUrl: string;
    private project: string;
    private repository: string;

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
            // Fetch the latest pipelines
            const pipelines = await this.client.getPullRequestPipelines(this.pullRequest.pullRequestId);
            webview.html = this.getHtmlForWebview(webview, this.pullRequest, pipelines);
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

    private getHtmlForWebview(webview: vscode.Webview, pr: PullRequest, pipelines: PipelineRun[]): string {
        const sourceBranch = pr.sourceRefName.replace('refs/heads/', '');
        const targetBranch = pr.targetRefName.replace('refs/heads/', '');

        // Construct the web URL for the pull request
        const prWebUrl = `${this.organizationUrl}/${this.project}/_git/${this.repository}/pullrequest/${pr.pullRequestId}`;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
                .pipelines {
                    margin-top: 30px;
                }
                .pipeline-item {
                    padding: 15px;
                    margin: 10px 0;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 5px;
                    border-left: 4px solid var(--vscode-panel-border);
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
                    margin-bottom: 10px;
                }
                .pipeline-name {
                    font-weight: bold;
                    font-size: 16px;
                }
                .pipeline-status {
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: bold;
                }
                .pipeline-details {
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                }
                .button {
                    display: inline-block;
                    margin-top: 10px;
                    padding: 6px 14px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    text-decoration: none;
                    border-radius: 4px;
                    font-size: 13px;
                }
                .button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .no-pipelines {
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                    padding: 20px;
                    text-align: center;
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

            <a href="${prWebUrl}" class="button">Open in Azure DevOps</a>

            ${pr.description ? `
            <h2>Description</h2>
            <div class="description">${this.escapeHtml(pr.description)}</div>
            ` : ''}

            <div class="pipelines">
                <h2>Pipelines (${pipelines.length})</h2>
                ${pipelines.length > 0 ? pipelines.map(pipeline => this.getPipelineHtml(pipeline)).join('') :
                '<div class="no-pipelines">No pipelines found for this pull request</div>'}
            </div>
        </body>
        </html>`;
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
}
