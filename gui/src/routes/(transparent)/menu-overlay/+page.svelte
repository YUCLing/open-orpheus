<script lang="ts">
  import { onMount, tick } from "svelte";

  import type { MenuSurfaceContract } from "@shared/contracts/menu-surface-api";
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

  interface Panel {
    id: string;
    parentId: string | null;
    depth: number;
    items: MenuItem[];
    x: number;
    y: number;
  }

  let config = $state<(MenuSurfaceConfig & { requestId: number }) | null>(null);
  let panels = $state<Panel[]>([]);
  let cursor = $state<{ x: number; y: number } | null>(null);
  let cursorFallback = $state(false);
  let showRequested = $state(false);
  let visible = $state(false);
  let hovered = $state<Record<string, number>>({});
  const panelEls: Record<string, HTMLDivElement | undefined> = {};
  let rootObserver: ResizeObserver | null = null;
  let observedRoot: HTMLElement | null = null;

  function applyColors(next: MenuSkin) {
    const root = document.documentElement;
    root.style.setProperty("--menu-bg", next.background);
    root.style.setProperty("--menu-fg", next.foreground);
    root.style.setProperty("--menu-fg-disabled", next.foregroundDisabled);
    root.style.setProperty("--menu-separator", next.separator);
    root.style.setProperty("--menu-item-hover", next.itemHover);
  }

  function updatePanel(id: string, patch: Partial<Panel>) {
    panels = panels.map((panel) => (panel.id === id ? { ...panel, ...patch } : panel));
  }

  async function positionRoot() {
    const first = panels[0];
    if (!first || !cursor) return;
    await document.fonts.ready;
    await tick();
    const element = panelEls[first.id];
    if (!element) return;
    if (observedRoot !== element) {
      rootObserver?.disconnect();
      observedRoot = element;
      rootObserver = new ResizeObserver(() => {
        if (cursor) void positionRoot();
      });
      rootObserver.observe(element);
    }
    const rect = element.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (cursorFallback) {
      updatePanel(first.id, {
        x: Math.max(0, Math.round((vw - rect.width) / 2)),
        y: Math.max(0, Math.round((vh - rect.height) / 2)),
      });
      return;
    }
    const onBottom = cursor.y > vh / 2;
    let x = cursor.x;
    let y = onBottom ? cursor.y - rect.height : cursor.y;
    if (x + rect.width > vw) x = vw - rect.width;
    if (y + rect.height > vh) y = vh - rect.height;
    updatePanel(first.id, { x: Math.max(0, x), y: Math.max(0, y) });
  }

  async function maybeReveal() {
    if (!config || !showRequested || !cursor || panels.length === 0) return;
    if (panels[0].x === 0 && panels[0].y === 0) await positionRoot();
    visible = true;
    await tick();
    await api.surface.visible({ requestId: config.requestId });
  }

  async function prepare(next: MenuSurfaceConfig & { requestId: number }) {
    config = next;
    panels = [
      {
        id: next.id,
        parentId: null,
        depth: 0,
        items: next.items as MenuItem[],
        x: 0,
        y: 0,
      },
    ];
    hovered = {};
    cursor = null;
    cursorFallback = false;
    showRequested = false;
    visible = false;
    loadTemplates(next.templates);
    applyColors(next.colors);
    await document.fonts.ready;
    await tick();
  }

  function applyUpdate(update: import("@shared/types/menu-surface").MenuUpdate) {
    if (update.items && panels.length > 0) {
      updatePanel(panels[0].id, { items: update.items as MenuItem[] });
    }
    if (update.templates) {
      loadTemplates(update.templates);
    }
    if (update.colors) applyColors(update.colors);
  }

  function closeFrom(index: number) {
    if (index + 1 < panels.length) panels = panels.slice(0, index + 1);
  }

  async function openChild(
    panelIndex: number,
    itemIndex: number,
    item: MenuItem,
    event: MouseEvent
  ) {
    if (!item.children?.length) return;
    const parent = panels[panelIndex];
    if (!parent) return;
    const childId = `${parent.id}:${itemIndex}:${item.menu_id ?? "item"}`;
    if (panels[panelIndex + 1]?.id === childId) return;
    closeFrom(panelIndex);
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const child: Panel = {
      id: childId,
      parentId: parent.id,
      depth: parent.depth + 1,
      items: item.children as MenuItem[],
      x: rect.right,
      y: rect.top,
    };
    panels = [...panels, child];
    await tick();
    const element = panelEls[child.id];
    if (!element) return;
    const childRect = element.getBoundingClientRect();
    let x = child.x;
    let y = child.y;
    if (x + childRect.width > window.innerWidth) x = rect.left - childRect.width;
    if (y + childRect.height > window.innerHeight) y = window.innerHeight - childRect.height;
    updatePanel(child.id, { x: Math.max(0, x), y: Math.max(0, y) });
  }

  function itemClick(item: MenuItem) {
    if (!item.enable) return;
    if (item.menu && item.children?.length) return;
    void api.surface.itemClick(item.menu_id);
  }

  function buttonClick(btn: MenuItemBtn) {
    if (!btn.enable) return;
    void api.surface.btnClick(btn.id);
  }

  function itemHover(
    panelIndex: number,
    panel: Panel,
    itemIndex: number,
    item: MenuItem,
    event: MouseEvent
  ) {
    hovered = { ...hovered, [panel.id]: itemIndex };
    if (item.menu && item.children?.length) {
      void openChild(panelIndex, itemIndex, item, event);
    } else {
      closeFrom(panelIndex);
    }
  }

  function itemLeave(panel: Panel, index: number) {
    if (hovered[panel.id] === index) hovered = { ...hovered, [panel.id]: -1 };
  }

  function outsideClick(event: MouseEvent) {
    if (event.target === event.currentTarget) void api.surface.close();
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") void api.surface.close();
  }

  onMount(() => {
    let disposed = false;

    api.events.surface.prepare((next) => {
      if (disposed) return;
      void prepare(next).catch((error) => console.error("overlay prepare failed", error));
    });

    api.events.surface.update((update) => {
      if (!disposed) applyUpdate(update);
    });

    api.events.surface.cursor(({ requestId, x, y, fallback }) => {
      if (disposed || !config || config.requestId !== requestId) return;
      cursor = { x, y };
      cursorFallback = fallback === true;
      void positionRoot().then(() => maybeReveal());
    });

    api.events.surface.show(({ requestId }) => {
      if (disposed || !config || config.requestId !== requestId) return;
      showRequested = true;
      void maybeReveal();
    });

    void api.surface
      .getFont()
      .then((font) => {
        setFont(font);
        if (cursor) void positionRoot();
      })
      .catch(() => undefined)
      .then(() => api.surface.ready());

    return () => {
      disposed = true;
      rootObserver?.disconnect();
      rootObserver = null;
      observedRoot = null;
    };
  });
</script>

<svelte:window
  onkeydown={keydown}
  onwheel={(event) => {
    if (!config) return;
    event.preventDefault();
    void api.surface.close();
  }}
/>

{#if config}
  <div
    class="fixed inset-0"
    style="visibility: {visible ? 'visible' : 'hidden'};"
    onclick={outsideClick}
    role="presentation"
  >
    {#if cursor}
      {#each panels as panel, index (panel.id)}
        <MenuPanel
          items={panel.items}
          hoveredIndex={hovered[panel.id] ?? -1}
          onitemclick={itemClick}
          onitemhover={(itemIndex, item, event) => itemHover(index, panel, itemIndex, item, event)}
          onitemleave={(i) => itemLeave(panel, i)}
          onbtnclick={buttonClick}
          bind:el={panelEls[panel.id]}
          style="left: {Math.round(panel.x)}px; top: {Math.round(panel.y)}px;"
          class={menuShadowClass}
          {@attach inputRegionAttachment}
        />
      {/each}
    {/if}
  </div>
{/if}
