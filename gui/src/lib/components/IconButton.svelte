<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";

  let {
    element = $bindable(),
    normal,
    hover,
    active,
    disabled,
    normalColor,
    hoverColor,
    activeColor,
    disabledColor,
    class: className,
    imgClass,
    ...rest
  }: Omit<HTMLButtonAttributes, "disabled"> & {
    element?: HTMLElement | undefined;
    normal: string;
    hover?: string;
    active?: string;
    disabled?: string;
    normalColor?: string;
    hoverColor?: string;
    activeColor?: string;
    disabledColor?: string;
    class?: string;
    imgClass?: string;
  } = $props();
</script>

{#snippet icon(src: string, color: string | undefined, cls: string)}
  {#if color}
    <div
      class="{cls} {imgClass}"
      style="background-color:{color};-webkit-mask-image:url({src});-webkit-mask-size:contain;-webkit-mask-repeat:no-repeat;-webkit-mask-position:center;mask-image:url({src});mask-size:contain;mask-repeat:no-repeat;mask-position:center"
    ></div>
  {:else}
    <img {src} class="{cls} {imgClass}" alt="" />
  {/if}
{/snippet}

<button
  bind:this={element}
  class="group/icon-btn {className}"
  disabled={!!disabled}
  {...rest}
>
  {#if disabled}
    {@render icon(disabled, disabledColor, "")}
  {:else}
    {@render icon(
      normal,
      normalColor,
      "block group-hover/icon-btn:hidden group-active/icon-btn:hidden"
    )}
    {@render icon(
      hover ?? normal,
      hoverColor ?? normalColor,
      "hidden group-hover/icon-btn:block group-active/icon-btn:hidden"
    )}
    {@render icon(
      active ?? hover ?? normal,
      activeColor ?? normalColor,
      "hidden group-hover/icon-btn:hidden group-active/icon-btn:block"
    )}
  {/if}
</button>
