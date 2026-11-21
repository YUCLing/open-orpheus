<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";

  import * as Accordion from "$lib/components/ui/accordion/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { getBridge } from "$lib/bridge";
  import { Button } from "$lib/components/ui/button";
  import {
    PluginAvailabilityKind,
    PluginKind,
    PluginPresentationStatus,
    PluginRuntimeStateKind,
    type PluginManagerContract,
    type PluginManagerEntry,
    type PluginManagerState,
    type PluginRealmSummary,
    type SerializablePluginRuntimeState,
  } from "@shared/contracts/plugin-manager-api";
  import {
    PluginConfigurationFailureStage,
    PluginConfigurationStateKind,
    type PluginConfigurationState,
    type PluginManagerHostBridge,
  } from "@shared/contracts/plugin-configuration";
  import { PluginConfigurationLoader } from "$lib/plugin-configuration/loader";
  import { REALM_DISPLAY_NAMES } from "virtual:open-orpheus/realm-display";

  import Package from "@lucide/svelte/icons/package";
  import Wrench from "@lucide/svelte/icons/wrench";
  import ToyBrick from "@lucide/svelte/icons/toy-brick";
  import type { Attachment } from "svelte/attachments";

  const api = getBridge<PluginManagerContract>("plugin");

  function realmLabel(realm: string): string {
    return REALM_DISPLAY_NAMES[realm] ?? realm;
  }

  const PRESENTATION_LABELS: Record<PluginPresentationStatus, string> = {
    [PluginPresentationStatus.Unavailable]: "不可用",
    [PluginPresentationStatus.Disabled]: "已停用",
    [PluginPresentationStatus.Starting]: "启动中",
    [PluginPresentationStatus.Running]: "运行中",
    [PluginPresentationStatus.Degraded]: "部分异常",
    [PluginPresentationStatus.Failed]: "加载失败",
    [PluginPresentationStatus.Stopping]: "停止中",
    [PluginPresentationStatus.CleanupFailed]: "清理失败",
  };

  const PRESENTATION_VARIANTS: Partial<
    Record<PluginPresentationStatus, "destructive" | "outline" | "secondary">
  > = {
    [PluginPresentationStatus.Unavailable]: "destructive",
    [PluginPresentationStatus.Failed]: "destructive",
    [PluginPresentationStatus.Degraded]: "destructive",
    [PluginPresentationStatus.CleanupFailed]: "destructive",
    [PluginPresentationStatus.Starting]: "outline",
    [PluginPresentationStatus.Stopping]: "outline",
  };

  const STATE_LABELS: Record<PluginRuntimeStateKind, string> = {
    [PluginRuntimeStateKind.Stopped]: "已停止",
    [PluginRuntimeStateKind.Starting]: "启动中",
    [PluginRuntimeStateKind.Running]: "运行中",
    [PluginRuntimeStateKind.Stopping]: "停止中",
    [PluginRuntimeStateKind.Failed]: "失败",
    [PluginRuntimeStateKind.Hung]: "无响应",
    [PluginRuntimeStateKind.Abandoned]: "已放弃",
    [PluginRuntimeStateKind.Disposed]: "已释放",
  };

  const ACTIVE_PRESENTATIONS = [
    PluginPresentationStatus.Running,
    PluginPresentationStatus.Degraded,
    PluginPresentationStatus.Starting,
  ];

  const STOPPED_PRESENTATIONS = [
    PluginPresentationStatus.Disabled,
    PluginPresentationStatus.CleanupFailed,
    PluginPresentationStatus.Stopping,
  ];

  const BLOCKED_PRESENTATIONS = [
    PluginPresentationStatus.Unavailable,
    PluginPresentationStatus.Failed,
  ];

  let pluginDialog = $state<string | null>(null);
  let managerState = $state<PluginManagerState | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let configurationStates = $state<Record<string, PluginConfigurationState>>({});

  const hostBridge = (window as unknown as { pluginManagerHost?: PluginManagerHostBridge })
    .pluginManagerHost;

  const configurationLoader = new PluginConfigurationLoader({
    waitForRealm: async (pluginId) =>
      (await hostBridge?.waitForRealm(pluginId)) ?? { kind: "missing" },
  });

  hostBridge?.setConfigurationHost({
    dispose: (pluginId, revision) => configurationLoader.dispose(pluginId, revision),
  });

  const configurationRoots = new SvelteMap<string, HTMLDivElement>();

  const plugins = $derived(managerState?.plugins ?? []);
  const running = $derived(
    plugins.filter((plugin) => ACTIVE_PRESENTATIONS.includes(plugin.presentation))
  );
  const stopped = $derived(
    plugins.filter((plugin) => STOPPED_PRESENTATIONS.includes(plugin.presentation))
  );
  const blocked = $derived(
    plugins.filter((plugin) => BLOCKED_PRESENTATIONS.includes(plugin.presentation))
  );

  const refreshConfigurationStates = () => {
    configurationStates = configurationLoader.snapshot();
  };

  onMount(() => {
    refreshConfigurationStates();
    configurationLoader.addEventListener("changed", refreshConfigurationStates);

    void load();
    api.events.changed(() => void load());

    return () => {
      configurationLoader.removeEventListener("changed", refreshConfigurationStates);
      void configurationLoader.disposeAll();
    };
  });

  function applyManagerState(state: PluginManagerState) {
    managerState = state;
    for (const plugin of state.plugins) {
      if (!plugin.desired.enabled) {
        void configurationLoader.dispose(plugin.id, plugin.desired.revision);
      }
    }
  }

  async function load() {
    try {
      applyManagerState(await api.list());
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function toggle(plugin: PluginManagerEntry) {
    busy = plugin.id;
    error = null;
    try {
      applyManagerState(await api.setEnabled(plugin.id, !plugin.desired.enabled));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }

  async function retry(plugin: PluginManagerEntry) {
    busy = plugin.id;
    error = null;
    try {
      applyManagerState(await api.retry(plugin.id));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }

  async function retryConfiguration(plugin: PluginManagerEntry) {
    const root = configurationRoots.get(plugin.id);
    const entryUrl = plugin.configuration.url;
    if (!root || !entryUrl) return;
    await configurationLoader.retry({
      pluginId: plugin.id,
      entryUrl,
      revision: plugin.desired.revision,
      requiresPreload: plugin.realms["plugin-manager"]?.declared === true,
      root,
    });
  }

  /** Retry only the cleanup of a disabled plugin's retained panel. */
  async function retryConfigurationCleanup(plugin: PluginManagerEntry) {
    await configurationLoader.dispose(plugin.id, plugin.desired.revision);
  }

  function retryable(plugin: PluginManagerEntry): boolean {
    if (!plugin.desired.enabled || plugin.availability.kind !== PluginAvailabilityKind.Available) {
      return false;
    }
    if (
      plugin.main.retryable ||
      plugin.main.kind === PluginRuntimeStateKind.Failed ||
      plugin.main.kind === PluginRuntimeStateKind.Hung
    ) {
      return true;
    }
    return Object.values(plugin.realms).some((summary) =>
      summary.instances.some(
        (instance) =>
          instance.state.retryable ||
          instance.state.kind === PluginRuntimeStateKind.Failed ||
          instance.state.kind === PluginRuntimeStateKind.Hung
      )
    );
  }

  function stateLabel(state: SerializablePluginRuntimeState): string {
    const stage = state.stage ? ` (${state.stage})` : "";
    return `${STATE_LABELS[state.kind]}${stage}`;
  }

  function realmEntries(entry: PluginManagerEntry): Array<[string, PluginRealmSummary]> {
    return Object.entries(entry.realms);
  }

  const configurationAttachments = new SvelteMap<string, { key: string; attachment: Attachment }>();

  function configurationAttachment(plugin: PluginManagerEntry): Attachment {
    const requiresPreload = plugin.realms["plugin-manager"]?.declared === true;
    const key = [
      plugin.id,
      plugin.desired.revision,
      plugin.configuration.url ?? "",
      requiresPreload,
    ].join("\0");
    const cached = configurationAttachments.get(plugin.id);
    if (cached?.key === key) return cached.attachment;

    const attachment: Attachment = (element) => {
      if (!(element instanceof HTMLDivElement)) return;
      const entryUrl = plugin.configuration.url;
      if (!plugin.configuration.declared || !entryUrl || !plugin.desired.enabled) return;

      configurationRoots.set(plugin.id, element);
      void configurationLoader.open({
        pluginId: plugin.id,
        entryUrl,
        revision: plugin.desired.revision,
        requiresPreload,
        root: element,
      });

      return () => {
        configurationRoots.delete(plugin.id);
        void configurationLoader.close(plugin.id);
      };
    };

    configurationAttachments.set(plugin.id, { key, attachment });
    return attachment;
  }

  const CONFIGURATION_LABELS: Record<PluginConfigurationStateKind, string> = {
    [PluginConfigurationStateKind.Unloaded]: "未加载",
    [PluginConfigurationStateKind.WaitingForPreload]: "正在等待插件管理器运行环境...",
    [PluginConfigurationStateKind.Loading]: "正在加载配置界面...",
    [PluginConfigurationStateKind.Ready]: "就绪",
    [PluginConfigurationStateKind.Mounting]: "正在挂载配置界面...",
    [PluginConfigurationStateKind.Mounted]: "已挂载",
    [PluginConfigurationStateKind.Unmounting]: "正在卸载配置界面...",
    [PluginConfigurationStateKind.Failed]: "配置界面加载失败",
  };

  const CONFIGURATION_STAGE_LABELS: Record<PluginConfigurationFailureStage, string> = {
    [PluginConfigurationFailureStage.Preload]: "运行环境",
    [PluginConfigurationFailureStage.Import]: "加载模块",
    [PluginConfigurationFailureStage.Validate]: "校验模块",
    [PluginConfigurationFailureStage.Mount]: "挂载",
    [PluginConfigurationFailureStage.Unmount]: "卸载",
  };

  function configurationBusy(state: PluginConfigurationState | undefined): boolean {
    if (!state) return false;
    return (
      state.kind === PluginConfigurationStateKind.WaitingForPreload ||
      state.kind === PluginConfigurationStateKind.Loading ||
      state.kind === PluginConfigurationStateKind.Mounting ||
      state.kind === PluginConfigurationStateKind.Unmounting
    );
  }
</script>

<svelte:head>
  <title>插件管理</title>
</svelte:head>

{#snippet pluginIcon(plugin: PluginManagerEntry)}
  {#if plugin.icon}
    <img src={plugin.icon} alt={plugin.name} class="size-full bg-gray-100 object-cover" />
  {:else}
    <div class="flex size-full items-center justify-center bg-gray-100">
      <Package class="size-5/8" />
    </div>
  {/if}
{/snippet}

{#snippet pluginCard(plugin: PluginManagerEntry)}
  {@const configuration = configurationStates[plugin.id]}
  <Card.Root class="shadow-md">
    <Card.Header class="flex items-center gap-2 drop-shadow-lg">
      <button
        class="group/plugin-icon relative size-14 shrink-0 cursor-pointer overflow-hidden rounded-lg"
        onclick={() => (pluginDialog = plugin.id)}
      >
        {@render pluginIcon(plugin)}
        <div
          class="invisible absolute top-0 left-0 flex size-full items-center justify-center bg-black/75 group-hover/plugin-icon:visible"
        >
          <Wrench class="text-white" />
        </div>
      </button>
      <div class="flex-1">
        <h1 class="text-lg font-bold">{plugin.name}</h1>
        <p class="text-gray-500">{plugin.author}</p>
      </div>
      <div class="flex flex-col items-end gap-2">
        {#if plugin.kind === PluginKind.Builtin}
          <Badge>内置</Badge>
        {/if}
        <Badge variant={PRESENTATION_VARIANTS[plugin.presentation] ?? "secondary"}>
          {PRESENTATION_LABELS[plugin.presentation]}
        </Badge>
      </div>
    </Card.Header>
    <Card.Content>
      <p>{plugin.description}</p>
      {#if plugin.availability.kind === PluginAvailabilityKind.Conflict}
        <div class="mt-2 text-sm text-red-700">
          <p>存在重复的插件 ID，以下插件均未加载：</p>
          <ul class="list-disc pl-5">
            {#each plugin.availability.paths as source (source)}
              <li><code>{source}</code></li>
            {/each}
          </ul>
        </div>
      {:else if plugin.availability.kind === PluginAvailabilityKind.Invalid}
        <p class="mt-2 text-sm text-red-700">{plugin.availability.error}</p>
      {/if}
      {#if plugin.shadowed.length > 0}
        <div class="mt-2 text-sm text-amber-700">
          <p>内置插件优先，以下同名第三方插件已被忽略：</p>
          <ul class="list-disc pl-5">
            {#each plugin.shadowed as source (source.path)}
              <li><code>{source.path}</code></li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if plugin.error}
        <p class="mt-2 text-sm text-red-700">{plugin.error}</p>
      {/if}
      {#if plugin.presentation === PluginPresentationStatus.CleanupFailed}
        <p class="mt-2 text-sm text-amber-700">
          插件已停用，但清理未完成；其影响可能持续到清理成功或应用退出。
        </p>
      {/if}
      {#each realmEntries(plugin) as [realm, summary] (realm)}
        {@const showRealm =
          summary.instances.length > 0 || (plugin.desired.enabled && summary.hostCount > 0)}
        {#if showRealm}
          <div class="mt-2 text-sm text-gray-600">
            <span class="font-medium">{realmLabel(realm)}</span>
            <span class="ml-2">窗口 {summary.hostCount}，实例 {summary.instances.length}</span>
            {#each summary.instances as instance (instance.webContentsId)}
              <span class="ml-2 rounded bg-gray-100 px-1">
                #{instance.webContentsId}
                {stateLabel(instance.state)}
              </span>
            {/each}
            {#each summary.instances as instance (instance.webContentsId)}
              {#if instance.state.error}
                <p class="mt-1 text-xs text-red-700">
                  #{instance.webContentsId}
                  {instance.state.error}
                </p>
              {/if}
            {/each}
            {#if plugin.desired.enabled && summary.hostCount > summary.instances.length}
              <span class="ml-2">等待上报</span>
            {/if}
          </div>
        {/if}
      {/each}
    </Card.Content>
    <Card.Footer class="flex content-end">
      <span class="flex-1 text-xs text-gray-500"
        >v{plugin.version}<br /><code>{plugin.id}</code></span
      >
      <div class="flex gap-2">
        {#if retryable(plugin)}
          <Button
            variant="outline"
            size="sm"
            disabled={busy === plugin.id}
            onclick={() => retry(plugin)}
          >
            重试
          </Button>
        {/if}
        {#if plugin.availability.kind === PluginAvailabilityKind.Available}
          <Button
            variant="outline"
            size="sm"
            disabled={busy === plugin.id}
            onclick={() => toggle(plugin)}
          >
            {busy === plugin.id ? "处理中..." : plugin.desired.enabled ? "停用" : "启用"}
          </Button>
        {/if}
      </div>
    </Card.Footer>
  </Card.Root>
  <Dialog.Root
    open={pluginDialog === plugin.id}
    onOpenChangeComplete={(value) => {
      if (!value) pluginDialog = null;
    }}
  >
    <Dialog.Content>
      <Dialog.Header>
        <Dialog.Title>插件配置</Dialog.Title>
        <Dialog.Description class="text-foreground">
          <div class="flex gap-2">
            <div class="size-18 overflow-hidden rounded-lg">
              {@render pluginIcon(plugin)}
            </div>
            <div>
              <h1 class="text-lg font-bold">
                {plugin.name}&nbsp;<span class="text-sm font-normal">v{plugin.version}</span>
              </h1>
              <p class="text-xs">{plugin.author}</p>
              <p class="text-xs"><code>{plugin.id}</code></p>
            </div>
          </div>
          <p class="mt-4">{plugin.description}</p>
          {#if plugin.error}
            <p class="mt-2 text-sm text-red-700">{plugin.error}</p>
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      {#if !plugin.configuration.declared}
        <p class="text-center">此插件暂无配置项</p>
      {:else if !plugin.desired.enabled && configuration?.kind === PluginConfigurationStateKind.Failed && configuration.stage === PluginConfigurationFailureStage.Unmount}
        <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <p>
            {CONFIGURATION_STAGE_LABELS[
              PluginConfigurationFailureStage.Unmount
            ]}失败：{configuration.error}
          </p>
          <p class="mt-1 text-xs">
            插件已停用，但配置面板的清理未完成；其监听器或定时器可能仍在运行。
          </p>
          <Button
            variant="outline"
            size="sm"
            class="mt-2"
            onclick={() => void retryConfigurationCleanup(plugin)}
          >
            重试清理
          </Button>
        </div>
      {:else if !plugin.desired.enabled}
        <p class="text-center">启用插件后可配置</p>
      {:else}
        <div class="space-y-2">
          {#if configuration?.kind === PluginConfigurationStateKind.Failed}
            <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <p>
                {CONFIGURATION_STAGE_LABELS[
                  configuration.stage ?? PluginConfigurationFailureStage.Import
                ]}失败：{configuration.error}
              </p>
              {#if configuration.retryable}
                <Button
                  variant="outline"
                  size="sm"
                  class="mt-2"
                  onclick={() => void retryConfiguration(plugin)}
                >
                  重试配置
                </Button>
              {/if}
            </div>
          {:else if configurationBusy(configuration)}
            <p class="text-sm text-gray-600">{CONFIGURATION_LABELS[configuration!.kind]}</p>
          {/if}
          <div
            class="[all:initial]"
            data-plugin-configuration
            data-plugin-id={plugin.id}
            {@attach configurationAttachment(plugin)}
          ></div>
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Root>
{/snippet}

{#snippet pluginSection(value: string, title: string, entries: PluginManagerEntry[])}
  <Accordion.Item {value} class="border-b-0!">
    <Accordion.Trigger class="cursor-pointer no-underline!">
      <div class="flex w-full pr-2">
        <h2 class="text-lg font-semibold">{title}</h2>
        <div class="flex-1"></div>
        <Badge variant="outline">{entries.length}个插件</Badge>
      </div>
    </Accordion.Trigger>
    <Accordion.Content class="px-2 pt-2 pb-6">
      {#if entries.length === 0}
        <p class="my-8 text-center text-gray-700">没有{title}插件。</p>
      {:else}
        <div class="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-4">
          {#each entries as plugin (plugin.id)}
            {@render pluginCard(plugin)}
          {/each}
        </div>
      {/if}
    </Accordion.Content>
  </Accordion.Item>
{/snippet}

<ScrollArea class="h-screen p-6">
  <div class="mb-4 flex items-center">
    <p class="flex-1 text-gray-700">
      插件允许你扩展 Open Orpheus 的功能，但<b>插件可以获得你系统的完整权限</b
      >，请只安装你所信任的插件。
    </p>
    <Button class="cursor-pointer" onclick={() => api.openPluginsFolder()}
      ><ToyBrick />打开插件目录</Button
    >
  </div>

  {#if error}
    <p class="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </p>
  {/if}

  {#if managerState === null}
    <p class="text-gray-700">正在加载插件...</p>
  {:else if !managerState.available}
    <p class="text-gray-700">插件系统已禁用。</p>
  {:else}
    <Accordion.Root type="multiple" value={["running", "stopped", "blocked"]}>
      {@render pluginSection("running", "运行中", running)}
      {@render pluginSection("stopped", "已停用", stopped)}
      {@render pluginSection("blocked", "不可用", blocked)}
    </Accordion.Root>
  {/if}
</ScrollArea>
