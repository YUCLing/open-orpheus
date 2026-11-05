<script lang="ts">
  import { onMount, tick } from "svelte";

  import type { MenuSurfaceContract } from "@shared/contracts/menu-surface-api";
  import type { ElementTemplate } from "@shared/types/dui";
  import type { MenuSkin } from "@shared/types/menu";
  import type { MenuSurfaceConfig } from "@shared/types/menu-surface";

  import { getBridge } from "$lib/bridge";
  import { setFont } from "$lib/font";
  import { inputRegionAttachment } from "$lib/inputRegion";

  import MenuPanel from "../menu/MenuPanel.svelte";
  import { loadTemplates } from "../menu/template";
  import type { MenuItem, MenuItemBtn } from "../menu/types";

  const api = getBridge<MenuSurfaceContract>("menu");

  const menuShadowClass = "shadow-[0_4px_16px_rgba(0,0,0,0.15),0_1px_4px_rgba(0,0,0,0.1)]";

  let config = $state<(MenuSurfaceConfig & { requestId: number }) | null>(null);
  let items: MenuItem[] = $state.raw([]);
  let templates: Record<string, ElementTemplate> = {};
  let shadowInset = $state(0);
  let visible = $state(false);
  let menuEl: HTMLDivElement | undefined = $state();
  let hoveredIndex = $state(-1);
  let openedChildIndex = $state(-1);

  function applyColors(next: MenuSkin) {
    const root = document.documentElement;
    root.style.setProperty("--menu-bg", next.background);
    root.style.setProperty("--menu-fg", next.foreground);
    root.style.setProperty("--menu-fg-disabled", next.foregroundDisabled);
    root.style.setProperty("--menu-separator", next.separator);
    root.style.setProperty("--menu-item-hover", next.itemHover);
  }

  async function applyPrepare(next: MenuSurfaceConfig & { requestId: number }) {
    config = next;
    items = next.items as MenuItem[];
    templates = next.templates;
    shadowInset = next.shadowInset ?? 0;
    hoveredIndex = -1;
    openedChildIndex = -1;
    visible = false;

    loadTemplates(next.templates);
    applyColors(next.colors);

    await document.fonts.ready;
    await tick();
    // Window surfaces are hidden while measuring; a task flush forces layout
    // without relying on rAF being scheduled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await reportCurrentSize();
  }

  async function reportCurrentSize() {
    if (!config) return;
    const element = menuEl;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const width = Math.ceil(rect.width) + shadowInset * 2;
    const height = Math.ceil(rect.height) + shadowInset * 2;
    await api.surface.reportSize({ requestId: config.requestId, width, height });
  }

  function applyUpdate(update: import("@shared/types/menu-surface").MenuUpdate) {
    if (update.items) items = update.items as MenuItem[];
    if (update.templates) {
      templates = update.templates;
      loadTemplates(update.templates);
    }
    if (update.colors) applyColors(update.colors);
    void tick()
      .then(reportCurrentSize)
      .catch((error) => {
        console.error("menu surface resize failed", error);
      });
  }

  onMount(() => {
    let disposed = false;

    api.events.surface.prepare((next) => {
      if (disposed) return;
      void applyPrepare(next).catch((error) => {
        console.error("menu surface prepare failed", error);
      });
    });

    api.events.surface.update((update) => {
      if (!disposed) applyUpdate(update);
    });

    api.events.surface.show(({ requestId }) => {
      if (disposed || !config || config.requestId !== requestId) return;
      visible = true;
      void tick().then(() => api.surface.visible({ requestId }));
    });

    void api.surface
      .getFont()
      .then(setFont)
      .catch(() => undefined)
      .then(() => api.surface.ready());

    return () => {
      disposed = true;
    };
  });

  function itemClick(item: MenuItem) {
    if (!item.enable) return;
    if (item.menu && item.children?.length) return;
    void api.surface.itemClick(item.menu_id);
  }

  function buttonClick(btn: MenuItemBtn) {
    if (!btn.enable) return;
    void api.surface.btnClick(btn.id);
  }

  function itemHover(index: number, item: MenuItem, event: MouseEvent) {
    hoveredIndex = index;
    const parent = config;
    if (!parent) return;

    if (item.menu && item.children?.length) {
      if (openedChildIndex === index) return;
      openedChildIndex = index;
      const target = event.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      try {
        void api.surface
          .openChild({
            parentId: parent.id,
            depth: parent.depth + 1,
            itemRect: {
              x: rect.right,
              y: rect.top,
              width: 0,
              height: rect.height,
            },
            items: item.children as never,
            templates,
          })
          .catch((error) => {
            openedChildIndex = -1;
            console.error("openChild failed", error);
          });
      } catch (error) {
        openedChildIndex = -1;
        console.error("openChild failed synchronously", error);
      }
    } else if (openedChildIndex !== -1) {
      openedChildIndex = -1;
      void api.surface.closeChildren(parent.id);
    }
  }

  function itemLeave(index: number) {
    if (hoveredIndex === index) hoveredIndex = -1;
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape" && config) void api.surface.close();
  }}
  onwheel={(event) => {
    if (!config) return;
    event.preventDefault();
    void api.surface.close();
  }}
/>

{#if config}
  <div class="fixed inset-0" style="visibility: {visible ? 'visible' : 'hidden'};">
    <MenuPanel
      {items}
      {hoveredIndex}
      onitemclick={itemClick}
      onitemhover={itemHover}
      onitemleave={itemLeave}
      onbtnclick={buttonClick}
      bind:el={menuEl}
      style="left: {shadowInset}px; top: {shadowInset}px;"
      class={menuShadowClass}
      {@attach inputRegionAttachment}
    />
  </div>
{/if}
