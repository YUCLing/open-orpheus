<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";

  import type { MenuItem, MenuItemBtn, LayoutNode } from "./types";
  import { getCachedTemplate } from "./template";
  import IconButton from "$lib/components/IconButton.svelte";

  let {
    items,
    hoveredIndex,
    showSubmenuArrows = true,
    style,
    el = $bindable(),
    onitemclick,
    onitemhover,
    onitemleave,
    onbtnclick,
    ...props
  }: {
    items: MenuItem[];
    hoveredIndex: number;
    showSubmenuArrows?: boolean;
    style?: string;
    el?: HTMLDivElement;
    onitemclick?: (item: MenuItem) => void;
    onitemhover?: (index: number, item: MenuItem, event: MouseEvent) => void;
    onitemleave?: (index: number) => void;
    onbtnclick?: (btn: MenuItemBtn) => void;
  } & HTMLAttributes<HTMLDivElement> = $props();
</script>

{#snippet layoutNode(node: LayoutNode, btns: MenuItemBtn[])}
  {#if node.type === "horizontal"}
    <div class="flex flex-row items-center">
      {#each node.children as child, ci (ci)}
        {@render layoutNode(child, btns)}
      {/each}
    </div>
  {:else if node.type === "vertical"}
    <div class="flex flex-col">
      {#each node.children as child, ci (ci)}
        {@render layoutNode(child, btns)}
      {/each}
    </div>
  {:else if node.type === "container"}
    <div
      class="flex shrink-0 flex-row items-center"
      style="{node.width != null ? `width:${node.width}px;` : ''}{node.height !=
      null
        ? `height:${node.height}px;`
        : ''}"
    >
      {#each node.children as child, ci (ci)}
        {@render layoutNode(child, btns)}
      {/each}
    </div>
  {:else if node.type === "control"}
    {#if node.width != null || node.height != null}
      <div
        class="shrink-0"
        style="{node.width != null
          ? `width:${node.width}px;`
          : ''}{node.height != null ? `height:${node.height}px;` : ''}"
      ></div>
    {:else}
      <div class="grow"></div>
    {/if}
  {:else if node.type === "button"}
    {@const btn = btns[node.index]}
    {#if btn?.images}
      <IconButton
        images={btn.images}
        disabled={!btn.enable}
        class="flex shrink-0 items-center justify-center {btn.enable
          ? 'cursor-pointer'
          : 'cursor-default'}"
        imgClass="size-full"
        style="width:{node.width}px;height:{node.height}px"
        onclick={() => onbtnclick?.(btn)}
      />
    {/if}
  {/if}
{/snippet}

{#snippet styledItem(item: MenuItem)}
  {@const tpl = item.style ? getCachedTemplate(item.style) : null}
  {#if tpl && item.btns}
    <div
      class="cursor-default select-none"
      style="height:{tpl.height}px;min-width:{tpl.minWidth}px;max-width:{tpl.maxWidth}px"
    >
      {@render layoutNode(tpl.layout, item.btns)}
    </div>
  {/if}
{/snippet}

<div
  class="absolute max-w-80 min-w-58 overflow-hidden rounded-lg py-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.15),0_1px_4px_rgba(0,0,0,0.1)] select-none"
  style="background-color: var(--menu-bg); {style ?? ''}"
  bind:this={el}
  {...props}
>
  {#each items as item, i (i)}
    {#if item.separator}
      <div
        class="mx-3 my-2 h-px"
        style="background-color: var(--menu-separator)"
      ></div>
    {:else if item.style && item.btns}
      {@render styledItem(item)}
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex cursor-default items-center gap-3 px-4 py-2 text-sm whitespace-nowrap transition-colors duration-50 {!item.enable
          ? 'pointer-events-none'
          : ''}"
        style="color: {!item.enable
          ? 'var(--menu-fg-disabled)'
          : 'var(--menu-fg)'}; background-color: {hoveredIndex === i
          ? 'var(--menu-item-hover)'
          : ''}"
        onclick={() => onitemclick?.(item)}
        onmouseenter={(e) => onitemhover?.(i, item, e)}
        onmouseleave={() => onitemleave?.(i)}
      >
        {#if item.image_path}
          <span
            class="size-5 shrink-0"
            style="background-color: {!item.enable
              ? 'var(--menu-fg-disabled)'
              : 'var(--menu-fg)'}; mask-image: url('{item.image_path}'); -webkit-mask-image: url('{item.image_path}'); mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; mask-position: center; -webkit-mask-position: center; mask-size: contain; -webkit-mask-size: contain;"
          ></span>
        {/if}
        <span class="flex-1">{item.text}</span>
        {#if item.check_image_path}
          <img
            class="ml-auto size-5 shrink-0 {!item.enable ? 'opacity-40' : ''}"
            src={item.check_image_path}
            alt=""
          />
        {:else if showSubmenuArrows && item.menu && item.children?.length}
          <img
            class="ml-auto size-5 shrink-0 opacity-50"
            src="gui://skin2/menu/sub_icon.svg"
            alt=""
          />
        {/if}
      </div>
    {/if}
  {/each}
</div>
