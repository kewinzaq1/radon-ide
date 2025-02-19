import { ConfigurationChangeEvent, workspace, Disposable } from "vscode";
import {
  PanelLocation,
  WorkspaceConfig,
  WorkspaceConfigProps,
  WorkspaceConfigEventMap,
  WorkspaceConfigEventListener,
} from "../common/WorkspaceConfig";
import { EventEmitter } from "stream";

export class WorkspaceConfigController implements Disposable, WorkspaceConfig {
  private config: WorkspaceConfigProps;
  private eventEmitter = new EventEmitter();
  private configListener: Disposable | undefined;

  constructor() {
    const configuration = workspace.getConfiguration("RadonIDE");
    this.config = {
      panelLocation: configuration.get<PanelLocation>("panelLocation")!,
      showDeviceFrame: configuration.get<boolean>("showDeviceFrame")!,
    };

    this.configListener = workspace.onDidChangeConfiguration((event: ConfigurationChangeEvent) => {
      if (!event.affectsConfiguration("RadonIDE")) {
        return;
      }
      const config = workspace.getConfiguration("RadonIDE");
      this.config = {
        panelLocation: config.get<PanelLocation>("panelLocation")!,
        showDeviceFrame: config.get<boolean>("showDeviceFrame")!,
      };
      this.eventEmitter.emit("configChange", this.config);
    });
  }

  async getConfig() {
    return this.config;
  }

  async update<K extends keyof WorkspaceConfigProps>(key: K, value: WorkspaceConfigProps[K]) {
    const configuration = workspace.getConfiguration("RadonIDE");
    if (configuration.inspect(key as string)?.workspaceValue) {
      await configuration.update(key as string, value, false);
    } else {
      await configuration.update(key as string, value, true);
    }
  }

  async addListener<K extends keyof WorkspaceConfigEventMap>(
    eventType: K,
    listener: WorkspaceConfigEventListener<WorkspaceConfigEventMap[K]>
  ) {
    this.eventEmitter.addListener(eventType, listener);
  }

  async removeListener<K extends keyof WorkspaceConfigEventMap>(
    eventType: K,
    listener: WorkspaceConfigEventListener<WorkspaceConfigEventMap[K]>
  ) {
    this.eventEmitter.removeListener(eventType, listener);
  }

  dispose() {
    this.configListener?.dispose();
  }
}
