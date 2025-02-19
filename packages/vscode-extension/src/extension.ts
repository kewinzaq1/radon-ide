import {
  commands,
  languages,
  debug,
  window,
  workspace,
  Uri,
  ExtensionContext,
  ExtensionMode,
  ConfigurationChangeEvent,
  DebugConfigurationProviderTriggerKind,
  DebugAdapterExecutable,
  Disposable,
} from "vscode";
import vscode from "vscode";
import { TabPanel } from "./panels/Tabpanel";
import { PreviewCodeLensProvider } from "./providers/PreviewCodeLensProvider";
import { DebugConfigProvider } from "./providers/DebugConfigProvider";
import { DebugAdapterDescriptorFactory } from "./debugging/DebugAdapterDescriptorFactory";
import { Logger, enableDevModeLogging } from "./Logger";
import {
  extensionContext,
  setAppRootFolder,
  setExtensionContext,
} from "./utilities/extensionContext";
import { command, setupPathEnv } from "./utilities/subprocess";
import fs from "fs";
import { SidePanelViewProvider } from "./panels/SidepanelViewProvider";
import { PanelLocation } from "./common/WorkspaceConfig";
import { getLaunchConfiguration } from "./utilities/launchConfiguration";
import { Project } from "./project/project";
import { findFilesInWorkspace, isWorkspaceRoot } from "./utilities/common";
import { Platform } from "./utilities/platform";

const BIN_MODIFICATION_DATE_KEY = "bin_modification_date";
const OPEN_PANEL_ON_ACTIVATION = "open_panel_on_activation";

function handleUncaughtErrors() {
  process.on("unhandledRejection", (error) => {
    Logger.error("Unhandled promise rejection", error);
  });
  process.on("uncaughtException", (error: Error) => {
    // @ts-ignore
    if (error.errno === -49) {
      // there is some weird EADDRNOTAVAIL uncaught error thrown in extension host
      // that does not seem to affect anything yet it gets reported here while not being
      // super valuable to the user – hence we ignore it.
      return;
    }
    Logger.error("Uncaught exception", error);
    Logger.openOutputPanel();
    window.showErrorMessage("Internal extension error.", "Dismiss");
  });
}

export function deactivate(context: ExtensionContext): undefined {
  TabPanel.currentPanel?.dispose();
  SidePanelViewProvider.currentProvider?.dispose();
  commands.executeCommand("setContext", "RNIDE.extensionIsActive", false);
  commands.executeCommand("setContext", "RNIDE.sidePanelIsClosed", false);
  return undefined;
}

export async function activate(context: ExtensionContext) {
  handleUncaughtErrors();

  if (Platform.OS !== "macos" && Platform.OS !== "windows") {
    window.showErrorMessage("Radon IDE works only on macOS and Windows.", "Dismiss");
    return;
  }

  setExtensionContext(context);
  if (context.extensionMode === ExtensionMode.Development) {
    enableDevModeLogging();
  }

  migrateOldConfiguration();

  if (Platform.OS === "macos") {
    try {
      await fixMacosBinary(context);
    } catch (error) {
      Logger.error("Error when processing simulator-server binaries", error);
      // we let the activation continue, as otherwise the diagnostics command would fail
    }
  }
  commands.executeCommand("setContext", "RNIDE.sidePanelIsClosed", false);

  async function showIDEPanel(fileName?: string, lineNumber?: number) {
    await commands.executeCommand("setContext", "RNIDE.sidePanelIsClosed", false);

    const panelLocation = workspace
      .getConfiguration("RadonIDE")
      .get<PanelLocation>("panelLocation");

    if (panelLocation !== "tab") {
      SidePanelViewProvider.showView(context, fileName, lineNumber);
    } else {
      TabPanel.render(context, fileName, lineNumber);
    }
  }

  async function closeIDEPanel(fileName?: string, lineNumber?: number) {
    const panelLocation = workspace
      .getConfiguration("RadonIDE")
      .get<PanelLocation>("panelLocation");

    if (panelLocation !== "tab") {
      commands.executeCommand("setContext", "RNIDE.sidePanelIsClosed", true);
    } else {
      TabPanel.currentPanel?.dispose();
    }
  }

  function closeWithConfirmation() {
    window
      .showWarningMessage("Are you sure you want to close the IDE panel?", "Yes", "No")
      .then((item) => {
        if (item === "Yes") {
          commands.executeCommand("RNIDE.closePanel");
        }
      });
  }

  async function showStorybookStory(componentTitle: string, storyName: string) {
    commands.executeCommand("RNIDE.openPanel");
    Project.currentProject?.showStorybookStory(componentTitle, storyName);
  }

  context.subscriptions.push(
    window.registerWebviewViewProvider(
      SidePanelViewProvider.viewType,
      new SidePanelViewProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  context.subscriptions.push(
    commands.registerCommand("RNIDE.performBiometricAuthorization", performBiometricAuthorization)
  );
  context.subscriptions.push(
    commands.registerCommand(
      "RNIDE.performFailedBiometricAuthorization",
      performFailedBiometricAuthorization
    )
  );
  context.subscriptions.push(commands.registerCommand("RNIDE.openDevMenu", openDevMenu));
  context.subscriptions.push(commands.registerCommand("RNIDE.closePanel", closeIDEPanel));
  context.subscriptions.push(commands.registerCommand("RNIDE.openPanel", showIDEPanel));
  context.subscriptions.push(commands.registerCommand("RNIDE.showPanel", showIDEPanel));
  context.subscriptions.push(
    commands.registerCommand("RNIDE.closeWithConfirmation", closeWithConfirmation)
  );
  context.subscriptions.push(
    commands.registerCommand("RNIDE.diagnose", diagnoseWorkspaceStructure)
  );
  context.subscriptions.push(
    commands.registerCommand("RNIDE.showStorybookStory", showStorybookStory)
  );

  async function closeAuxiliaryBar(registeredCommandDisposable: Disposable) {
    registeredCommandDisposable.dispose(); // must dispose to avoid endless loops

    const wasIDEPanelVisible = SidePanelViewProvider.currentProvider?.view?.visible;

    // run the built-in closeAuxiliaryBar command
    await commands.executeCommand("workbench.action.closeAuxiliaryBar");

    const isIDEPanelVisible = SidePanelViewProvider.currentProvider?.view?.visible;

    // if closing of Auxiliary bar affected the visibility of SidePanelView, we assume that it means that it was pinned to the secondary sidebar.
    if (wasIDEPanelVisible && !isIDEPanelVisible) {
      commands.executeCommand("RNIDE.closePanel");
    }

    // re-register to continue intercepting closeAuxiliaryBar commands
    registeredCommandDisposable = commands.registerCommand(
      "workbench.action.closeAuxiliaryBar",
      async (arg) => closeAuxiliaryBar(registeredCommandDisposable)
    );
    context.subscriptions.push(registeredCommandDisposable);
  }

  let closeAuxiliaryBarDisposable = commands.registerCommand(
    "workbench.action.closeAuxiliaryBar",
    async (arg) => closeAuxiliaryBar(closeAuxiliaryBarDisposable)
  );
  context.subscriptions.push(closeAuxiliaryBarDisposable);

  // Debug adapter used by custom launch configuration, we register it in case someone tries to run the IDE configuration
  // The current workflow is that people shouldn't run it, but since it is listed under launch options it might happen
  // When it does happen, we open the IDE panel and restart the app.
  context.subscriptions.push(
    debug.registerDebugAdapterDescriptorFactory(
      "react-native-ide", // we use previous type name here to support old launch configurations that were using "react-native-ide" type
      new LaunchConfigDebugAdapterDescriptorFactory()
    )
  );
  context.subscriptions.push(
    debug.registerDebugAdapterDescriptorFactory(
      "radon-ide",
      new LaunchConfigDebugAdapterDescriptorFactory()
    )
  );

  // Debug adapter used for debugging React Native apps
  context.subscriptions.push(
    debug.registerDebugConfigurationProvider(
      "com.swmansion.react-native-debugger",
      new DebugConfigProvider(),
      DebugConfigurationProviderTriggerKind.Dynamic
    )
  );

  context.subscriptions.push(
    debug.registerDebugAdapterDescriptorFactory(
      "com.swmansion.react-native-debugger",
      new DebugAdapterDescriptorFactory()
    )
  );

  context.subscriptions.push(
    languages.registerCodeLensProvider(
      [
        { scheme: "file", language: "typescriptreact" },
        { scheme: "file", language: "javascriptreact" },
        { scheme: "file", language: "typescript" },
        { scheme: "file", language: "javascript" },
      ],
      new PreviewCodeLensProvider()
    )
  );

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event: ConfigurationChangeEvent) => {
      if (event.affectsConfiguration("RadonIDE.panelLocation")) {
        showIDEPanel();
      }
    })
  );

  const appRoot = await configureAppRootFolder();
  if (!appRoot) {
    return;
  }

  if (Platform.OS === "macos") {
    try {
      await setupPathEnv(appRoot);
    } catch (error) {
      window.showWarningMessage(
        "Error when setting up PATH environment variable, RN IDE may not work correctly.",
        "Dismiss"
      );
    }
  }

  extensionActivated();
}

class LaunchConfigDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    commands.executeCommand("RNIDE.openPanel");
    // we can't return undefined or throw here because then VSCode displays an ugly error dialog
    // so we return a dummy adapter that calls echo command and exists immediately
    return new DebugAdapterExecutable("echo", ["noop"]);
  }
}

function extensionActivated() {
  if (extensionContext.workspaceState.get(OPEN_PANEL_ON_ACTIVATION)) {
    commands.executeCommand("RNIDE.openPanel");
  }
}

async function configureAppRootFolder() {
  const appRootFolder = await findAppRootFolder();
  if (appRootFolder) {
    Logger.info(`Found app root folder: ${appRootFolder}`);
    setAppRootFolder(appRootFolder);
    commands.executeCommand("setContext", "RNIDE.extensionIsActive", true);
  }
  return appRootFolder;
}

async function findAppRootCandidates(): Promise<string[]> {
  const candidates: string[] = [];

  const metroConfigUris = await findFilesInWorkspace("**/metro.config.{js,ts}", "**/node_modules");
  metroConfigUris.forEach((metroConfigUri) => {
    candidates.push(Uri.joinPath(metroConfigUri, "..").fsPath);
  });

  const appConfigUris = await findFilesInWorkspace("**/app.config.{js,ts}", "**/node_modules");
  appConfigUris.forEach((appConfigUri) => {
    const appRootFsPath = Uri.joinPath(appConfigUri, "..").fsPath;
    if (!candidates.includes(appRootFsPath)) {
      candidates.push(appRootFsPath);
    }
  });

  // given that if the user uses workspaces his node_modules are installed not in the root of an application,
  // but in the root of the workspace we need to detect workspaces root and exclude it.
  let excludePattern = null;
  workspace.workspaceFolders?.forEach((folder) => {
    if (isWorkspaceRoot(folder.uri.fsPath)) {
      excludePattern = "node_modules/react-native/package.json";
    }
  });

  const rnPackageLocations = await findFilesInWorkspace(
    "**/node_modules/react-native/package.json",
    excludePattern
  );
  rnPackageLocations.forEach((rnPackageLocation) => {
    const appRootFsPath = Uri.joinPath(rnPackageLocation, "../../..").fsPath;
    if (!candidates.includes(appRootFsPath)) {
      candidates.push(appRootFsPath);
    }
  });

  // app json is often used in non react-native projects, but in worst case scenario we can use it as a fallback
  const appJsonUris = await findFilesInWorkspace("**/app.json", "**/node_modules");
  appJsonUris.forEach((appJsonUri) => {
    const appRootFsPath = Uri.joinPath(appJsonUri, "..").fsPath;
    if (!candidates.includes(appRootFsPath)) {
      candidates.push(appRootFsPath);
    }
  });

  return candidates;
}

async function findAppRootFolder() {
  const launchConfiguration = getLaunchConfiguration();
  const appRootFromLaunchConfig = launchConfiguration.appRoot;
  if (appRootFromLaunchConfig) {
    let appRoot: string | undefined;
    workspace.workspaceFolders?.forEach((folder) => {
      const possibleAppRoot = Uri.joinPath(folder.uri, appRootFromLaunchConfig).fsPath;
      if (fs.existsSync(possibleAppRoot)) {
        appRoot = possibleAppRoot;
      }
    });
    if (!appRoot) {
      // when relative app location setting is set, we expect app root exists
      const openLaunchConfigButton = "Open Launch Configuration";
      window
        .showErrorMessage(
          `The app root folder does not exist in the workspace at ${appRootFromLaunchConfig}.`,
          openLaunchConfigButton
        )
        .then((item) => {
          if (item === openLaunchConfigButton) {
            commands.executeCommand("workbench.action.debug.configure");
          }
        });
      return undefined;
    }
    return appRoot;
  }

  const appRootCandidates = await findAppRootCandidates();

  if (appRootCandidates.length > 1) {
    const openLaunchConfigButton = "Open Launch Configuration";
    window
      .showWarningMessage(
        `Multiple react-native applications were detected in the workspace. "${appRootCandidates[0]}" was automatically chosen as your application root. To change that or remove this warning in the future, you can setup a permanent appRoot in Launch Configuration.`,
        openLaunchConfigButton
      )
      .then((item) => {
        if (item === openLaunchConfigButton) {
          commands.executeCommand("workbench.action.debug.configure");
        }
      });
  }

  if (appRootCandidates.length > 0) {
    return appRootCandidates[0];
  }

  const manageLaunchConfigButton = "Manage Launch Configuration";
  window
    .showErrorMessage(
      `
    Radon IDE couldn't find root application folder in this workspace.\n
    Please make sure that the opened workspace contains a valid React Native or Expo project.\n
    The way extension verifies the project is by looking for either: app.json, metro.config.js,
    or node_modules/react-native folder. If your project structure is different, you can set the
    app root using launch configuration.`,
      manageLaunchConfigButton,
      "Dismiss"
    )
    .then((item) => {
      if (item === manageLaunchConfigButton) {
        commands.executeCommand("debug.addConfiguration");
      }
    });
  return undefined;
}

async function openDevMenu() {
  Project.currentProject?.openDevMenu();
}

async function performBiometricAuthorization() {
  Project.currentProject?.sendBiometricAuthorization(true);
}

async function performFailedBiometricAuthorization() {
  Project.currentProject?.sendBiometricAuthorization(false);
}

async function diagnoseWorkspaceStructure() {
  const appRootFolder = await configureAppRootFolder();
  if (appRootFolder) {
    window
      .showInformationMessage(
        `
          Workspace structure seems to be ok.\n
          You can open the IDE Panel using the button below or from the command palette.`,
        "Open IDE Panel",
        "Cancel"
      )
      .then((item) => {
        if (item === "Open IDE Panel") {
          commands.executeCommand("RNIDE.openPanel");
        }
      });
  }
}

function migrateOldConfiguration() {
  // At the moment of migration, all configuration settings are considered "global"
  // in a sense that while they can potentially be set workspace-wide, they are not
  // intended to, and hence we are only interested in migrating global settings.

  // We ignore all potential errors that may occur in the process of migration.
  // The current settings are not as critical to break user experience in case any
  // of the method throws

  try {
    const oldConfiguration = workspace.getConfiguration("ReactNativeIDE");
    const newConfigurations = workspace.getConfiguration("RadonIDE");
    // iterate over all keys and set the in the new configuration
    for (const key in oldConfiguration) {
      try {
        if (oldConfiguration.has(key)) {
          const valueDetails = oldConfiguration.inspect(key);
          if (valueDetails?.globalValue) {
            newConfigurations.update(key, valueDetails.globalValue, true);
            oldConfiguration.update(key, valueDetails.defaultValue, true);
          }
        }
      } catch (e) {
        Logger.error("Error when migrating parameter", key, e);
      }
    }
  } catch (e) {
    Logger.error("Error when migrating old configuration", e);
  }
}

async function fixMacosBinary(context: ExtensionContext) {
  // MacOS prevents binary files from being executed when downloaded from the internet.
  // It requires notarization ticket to be available in the package where the binary was distributed
  // with. Apparently Apple does not allow for individual binary files to be notarized and only .app/.pkg and .dmg
  // files are allowed. To prevent the binary from being quarantined, we clone using byte-copy (with dd). This way the
  // quarantine attribute is removed. We try to do it only when the binary has been modified or for the new installation,
  // we detect that based on the modification date of the binary file.
  const buildBinPath = Uri.file(context.asAbsolutePath("dist/sim-server"));
  const exeBinPath = Uri.file(context.asAbsolutePath("dist/sim-server-executable"));

  // if build and exe binaries don't match, we need to clone the build binary – we always want the exe one to the exact
  // copy of the build binary:
  try {
    await command(`diff -q ${buildBinPath.fsPath} ${exeBinPath.fsPath}`);
  } catch (error) {
    // if binaries are different, diff will return non-zero code and we will land in catch clouse
    await command(`dd if=${buildBinPath.fsPath} of=${exeBinPath.fsPath}`);
  }
  await fs.promises.chmod(exeBinPath.fsPath, 0o755);
}
