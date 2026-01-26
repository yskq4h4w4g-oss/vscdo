import * as vscode from 'vscode';
import { AzureDevOpsClient, AzureDevOpsConfig, PullRequest } from './azureDevOpsClient';
import { PullRequestProvider } from './pullRequestProvider';
import { PullRequestWebviewPanel } from './pullRequestWebview';

const PAT_SECRET_KEY = 'azureDevOps.pat';

let client: AzureDevOpsClient | undefined;
let pullRequestProvider: PullRequestProvider;
let currentConfig: AzureDevOpsConfig | undefined;
let secretStorage: vscode.SecretStorage;

interface GitRemoteInfo {
    organizationUrl: string;
    project: string;
    repository: string;
}

function parseAzureDevOpsUrl(remoteUrl: string): GitRemoteInfo | undefined {
    // HTTPS format: https://dev.azure.com/org/project/_git/repo
    // HTTPS alt format: https://org.visualstudio.com/project/_git/repo
    // SSH format: git@ssh.dev.azure.com:v3/org/project/repo

    let match: RegExpMatchArray | null;

    // Try HTTPS dev.azure.com format (with optional username@)
    match = remoteUrl.match(/https:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/);
    if (match) {
        return {
            organizationUrl: `https://dev.azure.com/${match[1]}`,
            project: match[2],
            repository: match[3].replace(/\.git$/, '')
        };
    }

    // Try HTTPS visualstudio.com format (with optional username@)
    match = remoteUrl.match(/https:\/\/(?:[^@]+@)?([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)/);
    if (match) {
        return {
            organizationUrl: `https://dev.azure.com/${match[1]}`,
            project: match[2],
            repository: match[3].replace(/\.git$/, '')
        };
    }

    // Try SSH format
    match = remoteUrl.match(/git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (match) {
        return {
            organizationUrl: `https://dev.azure.com/${match[1]}`,
            project: match[2],
            repository: match[3].replace(/\.git$/, '')
        };
    }

    return undefined;
}

async function detectAzureDevOpsFromWorkspace(): Promise<GitRemoteInfo | undefined> {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
        console.log('Git extension not found');
        return undefined;
    }

    const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = git.getAPI(1);

    if (api.repositories.length === 0) {
        console.log('No git repositories found in workspace');
        return undefined;
    }

    const repo = api.repositories[0];
    const remotes = repo.state.remotes;

    // Try 'origin' first, then any other remote
    const originRemote = remotes.find(r => r.name === 'origin');
    const remote = originRemote || remotes[0];

    if (!remote) {
        console.log('No git remotes found');
        return undefined;
    }

    const remoteUrl = remote.fetchUrl || remote.pushUrl;
    if (!remoteUrl) {
        console.log('No remote URL found');
        return undefined;
    }

    console.log(`Detected git remote URL: ${remoteUrl}`);
    const info = parseAzureDevOpsUrl(remoteUrl);

    if (info) {
        console.log(`Detected Azure DevOps repo: ${info.organizationUrl}/${info.project}/${info.repository}`);
    }

    return info;
}

// Minimal type definitions for vscode.git extension
interface GitExtension {
    getAPI(version: 1): GitAPI;
}

interface GitAPI {
    repositories: Repository[];
}

interface Repository {
    state: RepositoryState;
}

interface RepositoryState {
    remotes: Remote[];
}

interface Remote {
    name: string;
    fetchUrl?: string;
    pushUrl?: string;
}

function getPullRequestWebUrl(pullRequestId: number): string {
    if (!currentConfig) {
        throw new Error('Azure DevOps not configured');
    }
    return `${currentConfig.organizationUrl}/${currentConfig.project}/_git/${currentConfig.repository}/pullrequest/${pullRequestId}`;
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('Azure DevOps extension is now active');

    // Initialize secret storage
    secretStorage = context.secrets;

    // Migrate PAT from old config-based storage to SecretStorage
    await migratePATToSecretStorage();

    // Initialize the pull request provider
    pullRequestProvider = new PullRequestProvider();
    vscode.window.registerTreeDataProvider('azureDevOpsPullRequests', pullRequestProvider);

    // Initialize client with current configuration
    await initializeClient();

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.configure', configureConnection),
        vscode.commands.registerCommand('azureDevOps.refreshPullRequests', refreshPullRequests),
        vscode.commands.registerCommand('azureDevOps.createPullRequest', createPullRequest),
        vscode.commands.registerCommand('azureDevOps.viewPullRequest', viewPullRequest),
        vscode.commands.registerCommand('azureDevOps.openPullRequestInBrowser', openPullRequestInBrowser),
        vscode.commands.registerCommand('azureDevOps.clearCredentials', clearCredentials)
    );

    // Listen for workspace folder changes to re-detect repo
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            console.log('Workspace folders changed, re-initializing client');
            await initializeClient();
        })
    );

    // Listen for secret storage changes
    context.subscriptions.push(
        context.secrets.onDidChange(async (e) => {
            if (e.key === PAT_SECRET_KEY) {
                console.log('PAT changed in secret storage, re-initializing client');
                await initializeClient();
            }
        })
    );

    // Show welcome message if PAT not configured
    const pat = await secretStorage.get(PAT_SECRET_KEY);
    if (!pat) {
        vscode.window.showInformationMessage(
            'Azure DevOps extension activated. Configure your PAT to get started.',
            'Configure'
        ).then(selection => {
            if (selection === 'Configure') {
                vscode.commands.executeCommand('azureDevOps.configure');
            }
        });
    }
}

/**
 * Migrates PAT from the old workspace configuration storage to the new SecretStorage.
 * This ensures a smooth transition for users upgrading from older versions.
 */
async function migratePATToSecretStorage(): Promise<void> {
    const config = vscode.workspace.getConfiguration('azureDevOps');
    const oldPat = config.get<string>('pat');

    if (oldPat) {
        // Check if we already have a PAT in secret storage
        const existingPat = await secretStorage.get(PAT_SECRET_KEY);

        if (!existingPat) {
            // Migrate the PAT to secret storage
            await secretStorage.store(PAT_SECRET_KEY, oldPat);
            console.log('Migrated PAT from workspace configuration to SecretStorage');
        }

        // Clear the old PAT from workspace configuration for security
        await config.update('pat', undefined, vscode.ConfigurationTarget.Global);
        await config.update('pat', undefined, vscode.ConfigurationTarget.Workspace);
        console.log('Cleared PAT from workspace configuration');

        vscode.window.showInformationMessage(
            'Your PAT has been migrated to secure storage.'
        );
    }
}

async function initializeClient() {
    const pat = await secretStorage.get(PAT_SECRET_KEY);

    if (!pat) {
        client = undefined;
        currentConfig = undefined;
        pullRequestProvider.setClient(undefined);
        console.log('Azure DevOps PAT not configured');
        return;
    }

    // Try to detect repo info from workspace git remote
    const detectedInfo = await detectAzureDevOpsFromWorkspace();

    if (!detectedInfo) {
        client = undefined;
        currentConfig = undefined;
        pullRequestProvider.setClient(undefined);
        console.log('Could not detect Azure DevOps repository from workspace');
        return;
    }

    const azureConfig: AzureDevOpsConfig = {
        organizationUrl: detectedInfo.organizationUrl,
        project: detectedInfo.project,
        repository: detectedInfo.repository,
        pat
    };

    try {
        client = new AzureDevOpsClient(azureConfig);
        currentConfig = azureConfig;
        pullRequestProvider.setClient(client);
        console.log(`Azure DevOps client initialized for ${detectedInfo.project}/${detectedInfo.repository}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to initialize Azure DevOps client: ${errorMessage}`);
        client = undefined;
        currentConfig = undefined;
        pullRequestProvider.setClient(undefined);
    }
}

async function configureConnection() {
    // Show detected repo info if available
    const detectedInfo = await detectAzureDevOpsFromWorkspace();
    if (detectedInfo) {
        vscode.window.showInformationMessage(
            `Detected: ${detectedInfo.project}/${detectedInfo.repository}`
        );
    } else {
        vscode.window.showWarningMessage(
            'No Azure DevOps repository detected. Open a folder with an Azure DevOps git remote.'
        );
    }

    // Get PAT - don't show the existing PAT for security reasons
    const pat = await vscode.window.showInputBox({
        prompt: 'Enter your Personal Access Token (PAT)',
        password: true,
        placeHolder: 'Your PAT with Code (Read & Write) and Build (Read) permissions',
        ignoreFocusOut: true
    });

    if (!pat) {
        return;
    }

    // Save PAT to secure storage
    await secretStorage.store(PAT_SECRET_KEY, pat);

    vscode.window.showInformationMessage('Azure DevOps PAT saved securely');

    // Reinitialize client
    await initializeClient();
}

/**
 * Clears the stored PAT from secure storage.
 */
async function clearCredentials() {
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to clear your stored PAT?',
        { modal: true },
        'Yes, Clear'
    );

    if (confirm === 'Yes, Clear') {
        await secretStorage.delete(PAT_SECRET_KEY);
        client = undefined;
        currentConfig = undefined;
        pullRequestProvider.setClient(undefined);
        vscode.window.showInformationMessage('Azure DevOps credentials cleared');
    }
}

async function refreshPullRequests() {
    if (!client) {
        vscode.window.showWarningMessage('Azure DevOps not configured. Please configure first.');
        return;
    }

    pullRequestProvider.refresh();
    vscode.window.showInformationMessage('Pull requests refreshed');
}

async function createPullRequest() {
    if (!client) {
        vscode.window.showWarningMessage('Azure DevOps not configured. Please configure first.');
        return;
    }

    try {
        // Get branches
        const branches = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Fetching branches...',
                cancellable: false
            },
            async () => {
                return await client!.getBranches();
            }
        );

        // Select source branch
        const sourceBranch = await vscode.window.showQuickPick(
            branches.map(b => b.replace('refs/heads/', '')),
            {
                placeHolder: 'Select source branch'
            }
        );

        if (!sourceBranch) {
            return;
        }

        // Select target branch
        const targetBranch = await vscode.window.showQuickPick(
            branches.filter(b => b !== `refs/heads/${sourceBranch}`).map(b => b.replace('refs/heads/', '')),
            {
                placeHolder: 'Select target branch'
            }
        );

        if (!targetBranch) {
            return;
        }

        // Get title
        const title = await vscode.window.showInputBox({
            prompt: 'Enter pull request title',
            placeHolder: 'Add new feature'
        });

        if (!title) {
            return;
        }

        // Get description
        const description = await vscode.window.showInputBox({
            prompt: 'Enter pull request description (optional)',
            placeHolder: 'Describe your changes...'
        });

        // Create PR
        const pr = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Creating pull request...',
                cancellable: false
            },
            async () => {
                return await client!.createPullRequest({
                    sourceRefName: `refs/heads/${sourceBranch}`,
                    targetRefName: `refs/heads/${targetBranch}`,
                    title,
                    description: description || ''
                });
            }
        );

        vscode.window.showInformationMessage(`Pull request #${pr.pullRequestId} created successfully`);
        pullRequestProvider.refresh();

        // Ask if user wants to open PR
        const webUrl = getPullRequestWebUrl(pr.pullRequestId);
        const action = await vscode.window.showInformationMessage(
            'Pull request created',
            'View Details',
            'Open in Browser',
            'Copy Link'
        );

        if (action === 'View Details') {
            viewPullRequest(pr);
        } else if (action === 'Open in Browser') {
            vscode.env.openExternal(vscode.Uri.parse(webUrl));
        } else if (action === 'Copy Link') {
            await vscode.env.clipboard.writeText(webUrl);
            vscode.window.showInformationMessage('PR link copied to clipboard');
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to create pull request: ${errorMessage}`);
    }
}

function viewPullRequest(pullRequest: PullRequest) {
    if (!client || !currentConfig) {
        vscode.window.showWarningMessage('Azure DevOps not configured');
        return;
    }

    PullRequestWebviewPanel.createOrShow(
        vscode.Uri.file(__dirname),
        client,
        pullRequest,
        currentConfig.organizationUrl,
        currentConfig.project,
        currentConfig.repository
    );
}

function openPullRequestInBrowser(pullRequest: PullRequest) {
    const webUrl = getPullRequestWebUrl(pullRequest.pullRequestId);
    vscode.env.openExternal(vscode.Uri.parse(webUrl));
}

export function deactivate() {
    console.log('Azure DevOps extension deactivated');
}
