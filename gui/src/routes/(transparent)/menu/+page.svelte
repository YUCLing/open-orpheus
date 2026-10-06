<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { MenuSkin } from "@shared/types/menu";
  import type { MenuItem, MenuItemBtn } from "./types";
  import type { ElementTemplate } from "$bridge/contracts/menu-api";
  import { loadTemplates } from "./template";
  import MenuPanel from "./MenuPanel.svelte";
  import { getBridge } from "$lib/bridge";
  import type { MenuContract } from "$bridge/contracts/menu-api";
  import { inputRegionAttachment } from "$lib/inputRegion";
  import { setFont } from "$lib/font";

  const api = getBridge<MenuContract>("menu");

  // Both the measuring window and the actual popup must use settled fonts.
  // Reporting a fallback-font size first permanently undersizes an xdg_popup.
  const fontReady = api
    .getFont()
    .then(setFont)
    .then(() => document.fonts.ready);

  let items: MenuItem[] = $state([]);
  let cursorX = $state(0);
  let cursorY = $state(0);
  let menuTop = $state(0); // computed anchor Y (top of menu box)
  let visible = $state(false);
  let menuReady = $state(false);
  let hoveredIndex = $state(-1);
  let menuEl: HTMLDivElement | undefined = $state();
  let waylandMode = $state(api.wayland);
  let rawTemplates: Record<string, ElementTemplate> = {};
  let isSubmenuMode = api.submenu;
  let shadowInset = $state(0);
  let pendingPopup = $state(false);
  let popupReady = $state(false);
  const menuShadowClass = "shadow-[0_4px_16px_rgba(0,0,0,0.15),0_1px_4px_rgba(0,0,0,0.1)]";

  function reportMenuSize(rect: DOMRect) {
    api.reportSize(
      Math.ceil(rect.width) + shadowInset * 2,
      Math.ceil(rect.height) + shadowInset * 2
    );
  }

  // Submenu state
  let submenuItems: MenuItem[] | null = $state(null);
  let submenuX = $state(0);
  let submenuY = $state(0);
  let submenuParentIndex = $state(-1);
  let submenuHoveredIndex = $state(-1);
  let submenuEl: HTMLDivElement | undefined = $state();

  function applyColors(colors: MenuSkin) {
    const root = document.documentElement;
    root.style.setProperty("--menu-bg", colors.background);
    root.style.setProperty("--menu-fg", colors.foreground);
    root.style.setProperty("--menu-fg-disabled", colors.foregroundDisabled);
    root.style.setProperty("--menu-separator", colors.separator);
    root.style.setProperty("--menu-item-hover", colors.itemHover);
  }

  /** Once we know the cursor position, clamp the menu and make it visible. */
  function commitMenuPosition() {
    tick().then(async () => {
      await document.fonts.ready;
      if (!menuEl) {
        return;
      }
      if (waylandMode) {
        const rect = menuEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Anchor: top half → top-left at cursor; bottom half → bottom-left at cursor
        const onBottomHalf = cursorY > vh / 2;
        let top = onBottomHalf ? cursorY - rect.height : cursorY;
        let left = cursorX;
        if (left + rect.width > vw) left = vw - rect.width;
        if (top + rect.height > vh) top = vh - rect.height;
        if (left < 0) left = 0;
        if (top < 0) top = 0;
        cursorX = left;
        menuTop = top;
      } else {
        const rect = menuEl.getBoundingClientRect();
        reportMenuSize(rect);
      }
      tick().then(() => {
        menuReady = true;
      });
    });
  }

  onMount(() => {
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    let observer: ResizeObserver | null = null;
    let disposed = false;
    // Listen before pull/measurement so a fast native conversion cannot race
    // the renderer's async bootstrap. Keep layout measurable while hidden.
    api.events.popupReady(() => {
      if (!disposed) popupReady = true;
    });
    if (waylandMode) {
      Promise.all([api.pull(), fontReady]).then(([data]) => {
        if (disposed) return;
        applyColors(data.colors);
        loadTemplates(data.templates);
        items = data.items as MenuItem[];
        hoveredIndex = -1;
        submenuItems = null;
        submenuParentIndex = -1;
        submenuHoveredIndex = -1;
        cursorX = data.cursorX ?? 0;
        cursorY = data.cursorY ?? 0;
        menuTop = cursorY;
        visible = true;
        commitMenuPosition();
      });

      api.events.update((rawItems) => {
        items = rawItems as MenuItem[];
      });
    } else if (isSubmenuMode) {
      Promise.all([api.pull(), fontReady]).then(([data]) => {
        if (disposed) return;
        shadowInset = data.shadowInset ?? 0;
        pendingPopup = data.pendingPopup ?? false;
        applyColors(data.colors);
        rawTemplates = data.templates;
        loadTemplates(data.templates);
        items = data.items as MenuItem[];
        hoveredIndex = -1;
        visible = true;
        menuReady = true;
        tick().then(async () => {
          await document.fonts.ready;
          if (disposed || !menuEl) return;
          observer = new ResizeObserver(() => {
            if (!menuEl) return;
            const rect = menuEl.getBoundingClientRect();
            reportMenuSize(rect);
          });
          observer.observe(menuEl);
        });
      });
    } else {
      // Non-Wayland: use ResizeObserver to keep the window sized to the menu
      const startObserver = () => {
        if (disposed || !menuEl || observer) return;
        observer = new ResizeObserver(() => {
          if (!menuEl) return;
          const rect = menuEl.getBoundingClientRect();
          reportMenuSize(rect);
        });
        observer.observe(menuEl);
      };

      Promise.all([api.pull(), fontReady]).then(([data]) => {
        if (disposed) return;
        shadowInset = data.shadowInset ?? 0;
        pendingPopup = data.pendingPopup ?? false;
        applyColors(data.colors);
        rawTemplates = data.templates;
        loadTemplates(data.templates);
        items = data.items as MenuItem[];
        hoveredIndex = -1;
        submenuItems = null;
        submenuParentIndex = -1;
        submenuHoveredIndex = -1;
        visible = true;
        menuReady = true;
        tick().then(async () => {
          await document.fonts.ready;
          if (disposed) return;
          startObserver();
          commitMenuPosition();
        });
      });

      api.events.update((rawItems) => {
        items = rawItems as MenuItem[];
      });
    }
    return () => {
      disposed = true;
      observer?.disconnect();
      root.style.overflow = previousOverflow;
    };
  });

  function handleItemClick(item: MenuItem) {
    if (!item.enable) return;
    if (item.menu && item.children?.length) return;
    api.itemClick(item.menu_id);
  }

  function handleBtnClick(btn: MenuItemBtn) {
    if (!btn.enable) return;
    api.btnClick(btn.id);
  }

  function handleItemHover(index: number, item: MenuItem, event: MouseEvent) {
    hoveredIndex = index;
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    if (item.menu && item.children?.length) {
      if (waylandMode && menuEl) {
        submenuX = rect.right;
        submenuY = rect.top;
        submenuItems = item.children;
        submenuParentIndex = index;
        submenuHoveredIndex = -1;

        tick().then(() => {
          if (!submenuEl) return;
          const subRect = submenuEl.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          if (submenuX + subRect.width > vw) submenuX = rect.left - subRect.width;
          if (submenuY + subRect.height > vh) submenuY = vh - subRect.height;
        });
      } else if (!isSubmenuMode && submenuParentIndex !== index) {
        api.openSubmenu($state.snapshot(item.children), rawTemplates, rect.right, rect.top);
        submenuParentIndex = index;
      }
    } else {
      submenuItems = null;
      if (!waylandMode && submenuParentIndex !== -1) {
        api.closeSubmenu();
      }
      submenuParentIndex = -1;
    }
  }

  function handleItemLeave(index: number) {
    if (hoveredIndex === index && submenuParentIndex !== index) hoveredIndex = -1;
  }

  function handleSubmenuItemClick(item: MenuItem) {
    if (!item.enable) return;
    if (item.menu && item.children?.length) return;
    api.itemClick(item.menu_id);
  }

  function handleOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      api.close();
      visible = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      api.close();
      visible = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
  {#if waylandMode}
    <!-- Wayland: fullscreen transparent overlay with menu positioned at cursor -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-99999" onclick={handleOverlayClick}>
      <MenuPanel
        {items}
        {hoveredIndex}
        onitemclick={handleItemClick}
        onitemhover={handleItemHover}
        onitemleave={handleItemLeave}
        onbtnclick={handleBtnClick}
        bind:el={menuEl}
        style="left: {cursorX}px; top: {menuTop}px; visibility: {menuReady ? 'visible' : 'hidden'};"
        class={menuShadowClass}
        {@attach inputRegionAttachment}
      />

      {#if submenuItems}
        <MenuPanel
          items={submenuItems}
          hoveredIndex={submenuHoveredIndex}
          onitemclick={handleSubmenuItemClick}
          onitemhover={(j) => {
            submenuHoveredIndex = j;
          }}
          onitemleave={() => {
            submenuHoveredIndex = -1;
          }}
          onbtnclick={handleBtnClick}
          showSubmenuArrows={false}
          bind:el={submenuEl}
          style="left: {submenuX}px; top: {submenuY}px;"
          class={menuShadowClass}
          {@attach inputRegionAttachment}
        />
      {/if}
    </div>
  {:else}
    <!-- Non-Wayland: the BrowserWindow IS the popup, no overlay needed -->
    <MenuPanel
      {items}
      {hoveredIndex}
      onitemclick={handleItemClick}
      onitemhover={handleItemHover}
      onitemleave={handleItemLeave}
      onbtnclick={handleBtnClick}
      bind:el={menuEl}
      style={`left: ${shadowInset}px; top: ${shadowInset}px; visibility: ${!pendingPopup || popupReady ? "visible" : "hidden"};`}
      class={shadowInset ? menuShadowClass : undefined}
    />
  {/if}
{/if}
