<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import type { BtnImages } from "@shared/types/dui";

  let {
    element = $bindable(),
    images,
    normal,
    hover,
    active,
    disable,
    normalColor,
    hoverColor,
    activeColor,
    disableColor,
    disabled,
    class: className,
    imgClass,
    ...rest
  }: HTMLButtonAttributes & {
    element?: HTMLElement | undefined;
    images?: BtnImages;
    normal?: string;
    hover?: string;
    active?: string;
    disable?: string;
    normalColor?: string;
    hoverColor?: string;
    activeColor?: string;
    disableColor?: string;
    class?: string;
    imgClass?: string;
  } = $props();

  let _normal = $derived(normal ?? images?.normal.uri ?? "");
  let _hover = $derived(hover ?? images?.hot?.uri ?? _normal);
  let _active = $derived(active ?? images?.pushed?.uri ?? _hover ?? _normal);
  let _disable = $derived(disable ?? images?.disabled?.uri);
  let _normalColor = $derived(normalColor ?? images?.normal.color);
  let _hoverColor = $derived(hoverColor ?? images?.hot?.color ?? _normalColor);
  let _activeColor = $derived(
    activeColor ?? images?.pushed?.color ?? _normalColor
  );
  let _disableColor = $derived(disableColor ?? images?.disabled?.color);
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
  {disabled}
  {...rest}
>
  {#if disabled}
    {@render icon(_disable ?? _normal, _disableColor ?? _normalColor, "")}
  {:else}
    {@render icon(
      _normal,
      _normalColor,
      "block group-hover/icon-btn:hidden group-active/icon-btn:hidden"
    )}
    {@render icon(
      _hover,
      _hoverColor,
      "hidden group-hover/icon-btn:block group-active/icon-btn:hidden"
    )}
    {@render icon(
      _active,
      _activeColor,
      "hidden group-hover/icon-btn:hidden group-active/icon-btn:block"
    )}
  {/if}
</button>
