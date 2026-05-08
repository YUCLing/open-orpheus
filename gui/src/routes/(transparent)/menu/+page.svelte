<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { MenuSkin } from "$lib/types";
  import type { MenuItem, MenuItemBtn } from "./types";
  import type { ElementTemplate } from "$bridge/contracts/menu-api";
  import { loadTemplates } from "./template";
  import MenuPanel from "./MenuPanel.svelte";
  import { getBridge } from "$lib/bridge";
  import type { MenuContract } from "$bridge/contracts/menu-api";

  const api = getBridge<MenuContract>("menu");

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
    tick().then(() => {
      if (!menuEl) return;
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
        api.reportSize(Math.ceil(rect.width), Math.ceil(rect.height));
      }
      tick().then(() => {
        menuReady = true;
      });
    });
  }

  onMount(() => {
    if (waylandMode) {
      api.pull().then((data) => {
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
      api.pull().then((data) => {
        applyColors(data.colors);
        rawTemplates = data.templates;
        loadTemplates(data.templates);
        items = data.items as MenuItem[];
        hoveredIndex = -1;
        visible = true;
        menuReady = true;
        tick().then(() => {
          if (!menuEl) return;
          const ro = new ResizeObserver(() => {
            if (!menuEl) return;
            const rect = menuEl.getBoundingClientRect();
            api.reportSize(Math.ceil(rect.width), Math.ceil(rect.height));
          });
          ro.observe(menuEl);
        });
      });
    } else {
      // Non-Wayland: use ResizeObserver to keep the window sized to the menu
      let ro: ResizeObserver | null = null;
      const startObserver = () => {
        if (!menuEl || ro) return;
        ro = new ResizeObserver(() => {
          if (!menuEl) return;
          const rect = menuEl.getBoundingClientRect();
          api.reportSize(Math.ceil(rect.width), Math.ceil(rect.height));
        });
        ro.observe(menuEl);
      };

      api.pull().then((data) => {
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
        tick().then(startObserver);
        commitMenuPosition();
      });

      api.events.update((rawItems) => {
        items = rawItems as MenuItem[];
      });
    }
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
    if (item.menu && item.children?.length) {
      const target = event.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
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
          if (submenuX + subRect.width > vw)
            submenuX = rect.left - subRect.width;
          if (submenuY + subRect.height > vh) submenuY = vh - subRect.height;
        });
      } else if (!isSubmenuMode && submenuParentIndex !== index) {
        api.openSubmenu(
          $state.snapshot(item.children),
          rawTemplates,
          rect.right,
          rect.top
        );
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
    if (hoveredIndex === index && submenuParentIndex !== index)
      hoveredIndex = -1;
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
        style="left: {cursorX}px; top: {menuTop}px; visibility: {menuReady
          ? 'visible'
          : 'hidden'};"
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
    />
  {/if}
{/if}
