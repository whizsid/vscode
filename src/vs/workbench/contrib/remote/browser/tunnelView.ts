/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/tunnelView';
import * as nls from 'vs/nls';
import * as dom from 'vs/base/browser/dom';
import { IViewDescriptor } from 'vs/workbench/common/views';
import { WorkbenchAsyncDataTree } from 'vs/platform/list/browser/listService';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IContextKeyService, IContextKey, RawContextKey, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { ICommandService, ICommandHandler, CommandsRegistry } from 'vs/platform/commands/common/commands';
import { Event, Emitter } from 'vs/base/common/event';
import { IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { ITreeRenderer, ITreeNode, IAsyncDataSource, ITreeContextMenuEvent } from 'vs/base/browser/ui/tree/tree';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { ViewletPane, IViewletPaneOptions } from 'vs/workbench/browser/parts/views/paneViewlet';
import { ActionBar, ActionViewItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { IconLabel } from 'vs/base/browser/ui/iconLabel/iconLabel';
import { ActionRunner, IAction } from 'vs/base/common/actions';
import { IMenuService, MenuId, IMenu, MenuRegistry, MenuItemAction } from 'vs/platform/actions/common/actions';
import { createAndFillInContextMenuActions, createAndFillInActionBarActions, ContextAwareMenuEntryActionViewItem } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IRemoteExplorerService, TunnelModel } from 'vs/workbench/services/remote/common/remoteExplorerService';

class TunnelTreeVirtualDelegate implements IListVirtualDelegate<ITunnelItem> {
	getHeight(element: ITunnelItem): number {
		return 22;
	}

	getTemplateId(element: ITunnelItem): string {
		return 'tunnelItemTemplate';
	}
}

export interface ITunnelViewModel {
	onForwardedPortsChanged: Event<void>;
	readonly forwarded: TunnelItem[];
	readonly published: TunnelItem[];
	readonly candidates: TunnelItem[];
	readonly groups: ITunnelGroup[];
}

export class TunnelViewModel extends Disposable implements ITunnelViewModel {
	private _onForwardedPortsChanged: Emitter<void> = new Emitter();
	public onForwardedPortsChanged: Event<void> = this._onForwardedPortsChanged.event;
	private model: TunnelModel;

	constructor(
		@IRemoteExplorerService remoteExplorerService: IRemoteExplorerService) {
		super();
		this.model = remoteExplorerService.tunnelModel;
		this._register(this.model.onForwardPort(() => this._onForwardedPortsChanged.fire()));
		this._register(this.model.onClosePort(() => this._onForwardedPortsChanged.fire()));
		this._register(this.model.onPortName(() => this._onForwardedPortsChanged.fire()));
	}

	get groups(): ITunnelGroup[] {
		const groups: ITunnelGroup[] = [];
		if (this.model.forwarded.size > 0) {
			groups.push({
				label: nls.localize('remote.tunnelsView.forwarded', "Forwarded"),
				tunnelType: TunnelType.Forwarded,
				items: this.forwarded
			});
		}
		if (this.model.published.size > 0) {
			groups.push({
				label: nls.localize('remote.tunnelsView.published', "Published"),
				tunnelType: TunnelType.Published,
				items: this.published
			});
		}
		const candidates = this.candidates;
		if (this.candidates.length > 0) {
			groups.push({
				label: nls.localize('remote.tunnelsView.candidates', "Candidates"),
				tunnelType: TunnelType.Candidate,
				items: candidates
			});
		}
		groups.push({
			label: nls.localize('remote.tunnelsView.add', "Add a Port..."),
			tunnelType: TunnelType.Add,
		});
		return groups;
	}

	get forwarded(): TunnelItem[] {
		return Array.from(this.model.forwarded.values()).map(tunnel => {
			return new TunnelItem(TunnelType.Forwarded, tunnel.remote, tunnel.closeable, tunnel.name, tunnel.description, tunnel.local);
		});
	}

	get published(): TunnelItem[] {
		return Array.from(this.model.published.values()).map(tunnel => {
			return new TunnelItem(TunnelType.Published, tunnel.remote, false, tunnel.name, tunnel.description, tunnel.local);
		});
	}

	get candidates(): TunnelItem[] {
		const candidates: TunnelItem[] = [];
		const values = this.model.candidates.values();
		let iterator = values.next();
		while (!iterator.done) {
			if (!this.model.forwarded.has(iterator.value.remote) && !this.model.published.has(iterator.value.remote)) {
				candidates.push(new TunnelItem(TunnelType.Candidate, iterator.value.remote, false, undefined, iterator.value.description));
			}
			iterator = values.next();
		}
		return candidates;
	}

	copy(tunnelItem: ITunnelItem) {
		// TODO: implement
	}

	dispose() {
		super.dispose();
	}
}

interface ITunnelTemplateData {
	elementDisposable: IDisposable;
	container: HTMLElement;
	iconLabel: IconLabel;
	actionBar: ActionBar;
}

class TunnelTreeRenderer extends Disposable implements ITreeRenderer<ITunnelGroup | ITunnelItem, ITunnelItem, ITunnelTemplateData> {
	static readonly ITEM_HEIGHT = 22;
	static readonly TREE_TEMPLATE_ID = 'tunnelItemTemplate';

	private _actionRunner: ActionRunner | undefined;

	constructor(
		private readonly viewId: string,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
	}

	set actionRunner(actionRunner: ActionRunner) {
		this._actionRunner = actionRunner;
	}

	get templateId(): string {
		return TunnelTreeRenderer.TREE_TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): ITunnelTemplateData {
		dom.addClass(container, 'custom-view-tree-node-item');
		const iconLabel = new IconLabel(container, { supportHighlights: true });
		// dom.addClass(iconLabel.element, 'tunnel-view-label');
		const actionsContainer = dom.append(iconLabel.element, dom.$('.actions'));
		const actionBar = new ActionBar(actionsContainer, {
			// actionViewItemProvider: undefined // this.actionViewItemProvider
			actionViewItemProvider: (action: IAction) => {
				if (action instanceof MenuItemAction) {
					return this.instantiationService.createInstance(ContextAwareMenuEntryActionViewItem, action);
				}

				return undefined;
			}
		});

		return { iconLabel, actionBar, container, elementDisposable: Disposable.None };
	}

	private isTunnelItem(item: ITunnelGroup | ITunnelItem): item is ITunnelItem {
		return !!((<ITunnelItem>item).remote);
	}

	renderElement(element: ITreeNode<ITunnelGroup | ITunnelItem, ITunnelGroup | ITunnelItem>, index: number, templateData: ITunnelTemplateData): void {
		templateData.elementDisposable.dispose();
		const node = element.element;
		// reset
		templateData.actionBar.clear();
		if (this.isTunnelItem(node)) {
			templateData.iconLabel.setLabel(node.label, node.description, { title: node.label + ' - ' + node.description, extraClasses: ['tunnel-view-label'] });
			templateData.actionBar.context = node;
			const contextKeyService = this.contextKeyService.createScoped();
			contextKeyService.createKey('view', this.viewId);
			contextKeyService.createKey('tunnelType', node.tunnelType);
			contextKeyService.createKey('tunnelCloseable', node.closeable);
			const menu = this.menuService.createMenu(MenuId.TunnelInline, contextKeyService);
			this._register(menu);
			const actions: IAction[] = [];
			this._register(createAndFillInActionBarActions(menu, { shouldForwardArgs: true }, actions));
			if (actions) {
				templateData.actionBar.push(actions, { icon: true, label: false });
				if (this._actionRunner) {
					templateData.actionBar.actionRunner = this._actionRunner;
				}
			}
		} else {
			templateData.iconLabel.setLabel(node.label);
		}
	}

	disposeElement(resource: ITreeNode<ITunnelGroup | ITunnelItem, ITunnelGroup | ITunnelItem>, index: number, templateData: ITunnelTemplateData): void {
		templateData.elementDisposable.dispose();
	}

	disposeTemplate(templateData: ITunnelTemplateData): void {
		templateData.actionBar.dispose();
		templateData.elementDisposable.dispose();
	}
}

class TunnelDataSource implements IAsyncDataSource<ITunnelViewModel, ITunnelItem | ITunnelGroup> {
	hasChildren(element: ITunnelViewModel | ITunnelItem | ITunnelGroup) {
		if (element instanceof TunnelViewModel) {
			return true;
		} else if (element instanceof TunnelItem) {
			return false;
		} else if ((<ITunnelGroup>element).items) {
			return true;
		}
		return false;
	}

	getChildren(element: ITunnelViewModel | ITunnelItem | ITunnelGroup) {
		if (element instanceof TunnelViewModel) {
			return element.groups;
		} else if (element instanceof TunnelItem) {
			return [];
		} else if ((<ITunnelGroup>element).items) {
			return (<ITunnelGroup>element).items!;
		}
		return [];
	}
}

enum TunnelType {
	Candidate = 'Candidate',
	Published = 'Published',
	Forwarded = 'Forwarded',
	Add = 'Add'
}

interface ITunnelGroup {
	tunnelType: TunnelType;
	label: string;
	items?: ITunnelItem[];
}

interface ITunnelItem {
	tunnelType: TunnelType;
	remote: string;
	local?: string;
	name?: string;
	closeable?: boolean;
	readonly description?: string;
	readonly label: string;
}

class TunnelItem implements ITunnelItem {
	constructor(
		public tunnelType: TunnelType,
		public remote: string,
		public closeable?: boolean,
		public name?: string,
		private _description?: string,
		public local?: string,
	) { }
	get label(): string {
		if (this.name) {
			return nls.localize('remote.tunnelsView.forwardedPortLabel0', "{0} to localhost", this.name);
		} else if (this.local === this.remote) {
			return nls.localize('remote.tunnelsView.forwardedPortLabel1', "{0} to localhost", this.remote);
		} else if (this.local) {
			return nls.localize('remote.tunnelsView.forwardedPortLabel2', "{0} to localhost:{1}", this.remote, this.local);
		} else {
			return nls.localize('remote.tunnelsView.forwardedPortLabel3', "{0} not forwarded", this.remote);
		}
	}

	get description(): string | undefined {
		if (this.name) {
			return nls.localize('remote.tunnelsView.forwardedPortDescription0', "remote {0} available at {1}", this.remote, this.local);
		} else if (this.local === this.remote) {
			return nls.localize('remote.tunnelsView.forwardedPortDescription1', "available at {0}", this.local);
		} else if (this.local) {
			return this._description;
		} else {
			return this._description;
		}
	}
}

export const TunnelTypeContextKey = new RawContextKey<TunnelType>('tunnelType', TunnelType.Add);
export const TunnelCloseableContextKey = new RawContextKey<boolean>('tunnelCloseable', false);

export class TunnelPanel extends ViewletPane {
	static readonly ID = '~remote.tunnelPanel';
	static readonly TITLE = nls.localize('remote.tunnel', "Tunnels");
	private tree!: WorkbenchAsyncDataTree<any, any, any>;
	private tunnelTypeContext: IContextKey<TunnelType>;
	private tunnelCloseableContext: IContextKey<boolean>;

	constructor(
		protected viewModel: ITunnelViewModel,
		options: IViewletPaneOptions,
		@IKeybindingService protected keybindingService: IKeybindingService,
		@IContextMenuService protected contextMenuService: IContextMenuService,
		@IContextKeyService protected contextKeyService: IContextKeyService,
		@IConfigurationService protected configurationService: IConfigurationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IOpenerService protected openerService: IOpenerService,
		@IQuickInputService protected quickInputService: IQuickInputService,
		@ICommandService protected commandService: ICommandService,
		@IMenuService private readonly menuService: IMenuService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService);
		this.tunnelTypeContext = TunnelTypeContextKey.bindTo(contextKeyService);
		this.tunnelCloseableContext = TunnelCloseableContextKey.bindTo(contextKeyService);
	}

	protected renderBody(container: HTMLElement): void {
		dom.addClass(container, '.tree-explorer-viewlet-tree-view');
		const treeContainer = document.createElement('div');
		dom.addClass(treeContainer, 'customview-tree');
		dom.addClass(treeContainer, 'file-icon-themable-tree');
		dom.addClass(treeContainer, 'show-file-icons');
		container.appendChild(treeContainer);
		const renderer = new TunnelTreeRenderer(TunnelPanel.ID, this.menuService, this.contextKeyService, this.instantiationService);
		this.tree = this.instantiationService.createInstance(WorkbenchAsyncDataTree,
			'RemoteTunnels',
			treeContainer,
			new TunnelTreeVirtualDelegate(),
			[renderer],
			new TunnelDataSource(),
			{
				keyboardSupport: true,
				collapseByDefault: (e: ITunnelItem | ITunnelGroup): boolean => {
					return false;
				}
			}
		);
		const actionRunner: ActionRunner = new ActionRunner();
		renderer.actionRunner = actionRunner;

		this._register(this.tree.onContextMenu(e => this.onContextMenu(e, actionRunner)));

		this.tree.setInput(this.viewModel);
		this._register(this.viewModel.onForwardedPortsChanged(() => {
			this.tree.updateChildren(undefined, true);
		}));

		// TODO: add navigator
		// const helpItemNavigator = this._register(new TreeResourceNavigator2(this.tree, { openOnFocus: false, openOnSelection: false }));

		// this._register(Event.debounce(helpItemNavigator.onDidOpenResource, (last, event) => event, 75, true)(e => {
		// 	e.element.handleClick();
		// }));
	}

	private get contributedContextMenu(): IMenu {
		const contributedContextMenu = this.menuService.createMenu(MenuId.TunnelContext, this.tree.contextKeyService);
		this._register(contributedContextMenu);
		return contributedContextMenu;
	}

	private onContextMenu(treeEvent: ITreeContextMenuEvent<ITunnelItem | ITunnelGroup>, actionRunner: ActionRunner): void {
		if (!(treeEvent.element instanceof TunnelItem)) {
			return;
		}
		const node: ITunnelItem | null = treeEvent.element;
		const event: UIEvent = treeEvent.browserEvent;

		event.preventDefault();
		event.stopPropagation();

		this.tree!.setFocus([node]);
		this.tunnelTypeContext.set(node.tunnelType);
		this.tunnelCloseableContext.set(!!node.closeable);

		const actions: IAction[] = [];
		this._register(createAndFillInContextMenuActions(this.contributedContextMenu, { shouldForwardArgs: true }, actions, this.contextMenuService));

		this.contextMenuService.showContextMenu({
			getAnchor: () => treeEvent.anchor,
			getActions: () => actions,
			getActionViewItem: (action) => {
				const keybinding = this.keybindingService.lookupKeybinding(action.id);
				if (keybinding) {
					return new ActionViewItem(action, action, { label: true, keybinding: keybinding.getLabel() });
				}
				return undefined;
			},
			onHide: (wasCancelled?: boolean) => {
				if (wasCancelled) {
					this.tree!.domFocus();
				}
			},
			getActionsContext: () => node,
			actionRunner
		});
	}

	protected layoutBody(height: number, width: number): void {
		this.tree.layout(height, width);
	}
}

export class TunnelPanelDescriptor implements IViewDescriptor {
	readonly id = TunnelPanel.ID;
	readonly name = TunnelPanel.TITLE;
	readonly ctorDescriptor: { ctor: any, arguments?: any[] };
	readonly canToggleVisibility = true;
	readonly hideByDefault = false;
	readonly workspace = true;
	readonly group = 'details@0';
	readonly remoteAuthority?: string | string[];

	constructor(viewModel: ITunnelViewModel, environmentService: IWorkbenchEnvironmentService) {
		this.ctorDescriptor = { ctor: TunnelPanel, arguments: [viewModel] };
		this.remoteAuthority = environmentService.configuration.remoteAuthority ? environmentService.configuration.remoteAuthority.split('+')[0] : undefined;
	}
}

namespace NameTunnelAction {
	export const ID = 'remote.tunnel.name';
	export const LABEL = nls.localize('remote.tunnel.name', "Name Tunnel");

	export function handler(): ICommandHandler {
		return async (accessor, arg) => {
			if (arg instanceof TunnelItem) {
				const remoteExplorerService = accessor.get(IRemoteExplorerService);
				const quickInputService = accessor.get(IQuickInputService);
				const name = await quickInputService.input({ placeHolder: nls.localize('remote.tunnelView.pickName', 'Port name, or leave blank for no name') });
				if (name === undefined) {
					return;
				}
				remoteExplorerService.tunnelModel.name(arg.remote, name);
			}
			return;
		};
	}
}

namespace ForwardPortAction {
	export const ID = 'remote.tunnel.forward';
	export const LABEL = nls.localize('remote.tunnel.forward', "Forward Port");

	export function handler(): ICommandHandler {
		return async (accessor, arg) => {
			if (arg instanceof TunnelItem) {
				const remoteExplorerService = accessor.get(IRemoteExplorerService);
				const quickInputService = accessor.get(IQuickInputService);
				const local: string = await quickInputService.input({ placeHolder: nls.localize('remote.tunnelView.pickLocal', 'Local port to forward to, or leave blank for {0}', arg.remote) });
				if (local === undefined) {
					return;
				}
				const name = await quickInputService.input({ placeHolder: nls.localize('remote.tunnelView.pickName', 'Port name, or leave blank for no name') });
				if (name === undefined) {
					return;
				}
				remoteExplorerService.tunnelModel.forward(arg.remote, (local !== '') ? local : arg.remote, (name !== '') ? name : undefined);
			}
		};
	}
}

namespace ClosePortAction {
	export const ID = 'remote.tunnel.close';
	export const LABEL = nls.localize('remote.tunnel.close', "Stop Forwarding Port");

	export function handler(): ICommandHandler {
		return async (accessor, arg) => {
			if (arg instanceof TunnelItem) {
				const remoteExplorerService = accessor.get(IRemoteExplorerService);
				remoteExplorerService.tunnelModel.close(arg.remote);
			}
		};
	}
}

namespace OpenPortInBrowserAction {
	export const ID = 'remote.tunnel.open';
	export const LABEL = nls.localize('remote.tunnel.open', "Open in Browser");

	export function handler(): ICommandHandler {
		return async (accessor, arg) => {
			if (arg instanceof TunnelItem) {
				const model = accessor.get(IRemoteExplorerService).tunnelModel;
				const openerService = accessor.get(IOpenerService);
				const tunnel = model.forwarded.has(arg.remote) ? model.forwarded.get(arg.remote) : model.published.get(arg.remote);
				if (tunnel && tunnel.uri) {
					return openerService.open(tunnel.uri);
				}
				return Promise.resolve();
			}
		};
	}
}

CommandsRegistry.registerCommand(NameTunnelAction.ID, NameTunnelAction.handler());
CommandsRegistry.registerCommand(ForwardPortAction.ID, ForwardPortAction.handler());
CommandsRegistry.registerCommand(ClosePortAction.ID, ClosePortAction.handler());
CommandsRegistry.registerCommand(OpenPortInBrowserAction.ID, OpenPortInBrowserAction.handler());

MenuRegistry.appendMenuItem(MenuId.TunnelContext, ({
	group: '0_manage',
	order: 0,
	command: {
		id: OpenPortInBrowserAction.ID,
		title: OpenPortInBrowserAction.LABEL,
	},
	when: ContextKeyExpr.or(TunnelTypeContextKey.isEqualTo(TunnelType.Forwarded), TunnelTypeContextKey.isEqualTo(TunnelType.Published))
}));
MenuRegistry.appendMenuItem(MenuId.TunnelContext, ({
	group: '0_manage',
	order: 1,
	command: {
		id: NameTunnelAction.ID,
		title: NameTunnelAction.LABEL,
	},
	when: TunnelTypeContextKey.isEqualTo(TunnelType.Forwarded)
}));
MenuRegistry.appendMenuItem(MenuId.TunnelContext, ({
	group: '0_manage',
	order: 0,
	command: {
		id: ForwardPortAction.ID,
		title: ForwardPortAction.LABEL,
	},
	when: ContextKeyExpr.or(TunnelTypeContextKey.isEqualTo(TunnelType.Candidate), TunnelTypeContextKey.isEqualTo(TunnelType.Published))
}));
MenuRegistry.appendMenuItem(MenuId.TunnelContext, ({
	group: '0_manage',
	order: 2,
	command: {
		id: ClosePortAction.ID,
		title: ClosePortAction.LABEL,
	},
	when: TunnelCloseableContextKey
}));

MenuRegistry.appendMenuItem(MenuId.TunnelInline, ({
	order: 0,
	command: {
		id: OpenPortInBrowserAction.ID,
		title: OpenPortInBrowserAction.LABEL,
		iconClassName: 'codicon-globe',
		iconLocation: {
			dark: undefined,
			light: undefined
		}
	},
	when: ContextKeyExpr.or(TunnelTypeContextKey.isEqualTo(TunnelType.Forwarded), TunnelTypeContextKey.isEqualTo(TunnelType.Published))
}));
MenuRegistry.appendMenuItem(MenuId.TunnelInline, ({
	order: 0,
	command: {
		id: ForwardPortAction.ID,
		title: ForwardPortAction.LABEL,
		iconClassName: 'codicon-plus',
		iconLocation: {
			dark: undefined,
			light: undefined
		}
	},
	when: ContextKeyExpr.or(TunnelTypeContextKey.isEqualTo(TunnelType.Candidate), TunnelTypeContextKey.isEqualTo(TunnelType.Published))
}));
MenuRegistry.appendMenuItem(MenuId.TunnelInline, ({
	order: 2,
	command: {
		id: ClosePortAction.ID,
		title: ClosePortAction.LABEL,
		iconClassName: 'codicon-x',
		iconLocation: {
			dark: undefined,
			light: undefined
		}
	},
	when: TunnelCloseableContextKey
}));
