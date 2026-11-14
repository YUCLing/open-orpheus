<script lang="ts">
  import { onMount } from "svelte";

  import * as Accordion from "$lib/components/ui/accordion/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { getBridge } from "$lib/bridge";
  import { Button } from "$lib/components/ui/button";
  import {
    PluginActivationStatus,
    PluginKind,
    type PluginManagerContract,
    type PluginManagerEntry,
    type PluginManagerState,
  } from "@shared/contracts/plugin-manager-api";

  import Package from "@lucide/svelte/icons/package";
  import Wrench from "@lucide/svelte/icons/wrench";

  const api = getBridge<PluginManagerContract>("plugin");

  let pluginDialog = $state<string | null>(null);
  let managerState = $state<PluginManagerState | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);

  const active = $derived(
    managerState?.plugins.filter(
      (plugin: PluginManagerEntry) => plugin.status === PluginActivationStatus.Active
    ) ?? []
  );
  const inactive = $derived(
    managerState?.plugins.filter(
      (plugin: PluginManagerEntry) => plugin.status !== PluginActivationStatus.Active
    ) ?? []
  );

  onMount(() => {
    void load();
    api.events.changed(() => void load());
  });

  async function load() {
    try {
      managerState = await api.list();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function toggle(plugin: PluginManagerEntry) {
    busy = plugin.id;
    error = null;
    try {
      managerState = await api.setEnabled(plugin.id, !plugin.enabled);
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
      managerState = await api.setEnabled(plugin.id, true);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = null;
    }
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
  <Card.Root class="shadow-md">
    <Card.Header class="flex items-center gap-2 drop-shadow-lg">
      <button
        class="group/plugin-icon relative size-14 cursor-pointer overflow-hidden rounded-lg"
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
        {#if plugin.status === PluginActivationStatus.Failed}
          <Badge variant="destructive">加载失败</Badge>
        {:else if plugin.status === PluginActivationStatus.Partial}
          <Badge variant="destructive">部分激活</Badge>
        {/if}
      </div>
    </Card.Header>
    <Card.Content>
      <p>{plugin.description}</p>
      {#if plugin.error}
        <p class="mt-2 text-sm text-red-700">{plugin.error}</p>
      {/if}
      {#if plugin.preloadError}
        <p class="mt-2 text-sm text-red-700">预加载: {plugin.preloadError}</p>
      {/if}
    </Card.Content>
    <Card.Footer class="flex content-end">
      <span class="flex-1 text-xs text-gray-500"
        >v{plugin.version}<br /><code>{plugin.id}</code></span
      >
      <div class="flex gap-2">
        {#if plugin.status === PluginActivationStatus.Failed || plugin.status === PluginActivationStatus.Partial}
          <Button
            variant="outline"
            size="sm"
            disabled={busy === plugin.id}
            onclick={() => retry(plugin)}
          >
            重试
          </Button>
        {/if}
        <Button
          variant="outline"
          size="sm"
          disabled={busy === plugin.id}
          onclick={() => toggle(plugin)}
        >
          {busy === plugin.id ? "处理中..." : plugin.enabled ? "停用" : "启用"}
        </Button>
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
          {#if plugin.preloadError}
            <p class="mt-2 text-sm text-red-700">预加载: {plugin.preloadError}</p>
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      <p class="text-center">暂不支持插件配置</p>
    </Dialog.Content>
  </Dialog.Root>
{/snippet}

{#snippet pluginSection(value: string, title: string, plugins: PluginManagerEntry[])}
  <Accordion.Item {value} class="border-b-0!">
    <Accordion.Trigger class="cursor-pointer no-underline!">
      <div class="flex w-full pr-2">
        <h2 class="text-lg font-semibold">{title}</h2>
        <div class="flex-1"></div>
        <Badge variant="outline">{plugins.length}个插件</Badge>
      </div>
    </Accordion.Trigger>
    <Accordion.Content class="px-2 pt-2 pb-6">
      {#if plugins.length === 0}
        <p class="my-8 text-center text-gray-700">没有{title}插件。</p>
      {:else}
        <div class="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-4">
          {#each plugins as plugin (plugin.id)}
            {@render pluginCard(plugin)}
          {/each}
        </div>
      {/if}
    </Accordion.Content>
  </Accordion.Item>
{/snippet}

<ScrollArea class="h-screen p-6">
  <p class="mb-4 text-gray-700">
    插件允许你扩展 Open Orpheus 的功能，但<b>插件可以获得你系统的完整权限</b>。
  </p>

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
    <Accordion.Root type="multiple" value={["active", "inactive"]}>
      {@render pluginSection("active", "已激活", active)}
      {@render pluginSection("inactive", "未激活", inactive)}
    </Accordion.Root>
  {/if}
</ScrollArea>
