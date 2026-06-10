<script lang="ts">
  import { onMount } from "svelte";
  import LyricsComponent from "$lib/components/Lyrics.svelte";
  import type { LyricsStyle } from "$sharedTypes/desktop-lyrics";
  import type { Lyrics, LyricsStore } from "$sharedTypes/lyrics";
  import IconButton from "$lib/components/IconButton.svelte";
  import { cn } from "$lib/utils";
  import { getBridge } from "$lib/bridge";
  import type { DesktopLyricsContract } from "$bridge/contracts/desktop-lyrics-api";
  import { inputRegionAttachment } from "$lib/inputRegion";
  import {
    lyricsBridgeEmitter,
    getLyrics,
    getSlogan,
    getPlayState,
    getTime,
  } from "$lib/lyrics";
  import * as settings from "$lib/settings";

  const api = getBridge<DesktopLyricsContract>("desktopLyrics");

  let opacity = $state(1);
  let lyricStyle = $state<LyricsStyle | null>(null);

  let lrcLyrics: Lyrics | null = $state(null);
  let perwordLyrics: Lyrics | null = $state(null);
  let translateLyrics: Lyrics | null = $state(null);
  let romaLyrics: Lyrics | null = $state(null);
  let slogan: string | null = $state(null);

  let currentTime = $state(0);
  let offset = $state(0);
  let playing = $state(false);
  let locked = $state(false);
  let interpolatedLyricLine = $state(true);

  let lyrics = $derived.by(() => {
    if (perwordLyrics) return perwordLyrics;
    if (lrcLyrics) return lrcLyrics;
    return null;
  });
  let secondaryLyrics = $derived.by(() => {
    if (!lyricStyle) return null;
    if (lyricStyle.showTranslate === "translate") return translateLyrics;
    if (lyricStyle.showTranslate === "roman") return romaLyrics;
    return null;
  });
  let useProgress = $derived(perwordLyrics !== null || interpolatedLyricLine);

  const items: ([string, string, string] | [string, string, string, true])[] =
    $derived([
      ["home", "detail", "打开详情页"],
      ["poffset", "offset_forward", "向前偏移歌词 0.5 秒"], // TODO: In what situations offsets will be locked
      ["moffset", "offset_back", "向后偏移歌词 0.5 秒"],
      ["prev", "playprev", "播放上一首"],
      [playing ? "topause" : "toplay", "play_pause", playing ? "暂停" : "播放"],
      ["next", "playnext", "播放下一首"],
      ["setting", "setting", "设置"],
      ["lock", "lock", "锁定桌面歌词"],
      ["close", "close", "关闭桌面歌词"],
    ]);

  let previousVertical = false;
  $effect(() => {
    if (!lyricStyle) return;
    if (lyricStyle.vertical !== previousVertical) {
      previousVertical = lyricStyle.vertical;
      api.changeOrientation();
    }
  });

  // This component would never be unmounted, events does not need to be removed.
  settings.events.on("change", (e) => {
    const { key, value } = e.data;
    if (key === "desktopLyrics.interpolatedLyricLine") {
      interpolatedLyricLine = value as boolean;
    } else if (key === "desktopLyrics.opacity") {
      opacity = value as number;
    }
  });
  settings.get("desktopLyrics.interpolatedLyricLine").then((v) => {
    if (v === undefined) return;
    interpolatedLyricLine = v as boolean;
  });
  settings.get("desktopLyrics.opacity").then((v) => {
    if (v === undefined) return;
    opacity = v as number;
  });

  onMount(() => {
    api.events.styleUpdate((data) => {
      lyricStyle = data;
    });

    api.events.lockUpdate((isLocked) => {
      locked = isLocked;
    });

    api.events.offsetUpdate((newOffset) => {
      offset = newOffset;
    });

    api.requestFullUpdate();

    const updateLyrics = (store: LyricsStore | null) => {
      if (!store) {
        lrcLyrics = perwordLyrics = translateLyrics = romaLyrics = null;
        return;
      }
      lrcLyrics = store.regular;
      perwordLyrics = store["per-word"] ?? null;
      translateLyrics = store.translate ?? null;
      romaLyrics = store.roma ?? null;
    };

    updateLyrics(getLyrics());

    slogan = getSlogan();
    currentTime = getTime();
    playing = getPlayState();

    lyricsBridgeEmitter.on("lyricsupdate", (e) => {
      updateLyrics(e.data);
    });

    lyricsBridgeEmitter.on("sloganupdate", (e) => {
      slogan = e.data;
    });

    lyricsBridgeEmitter.on("raf", (e) => {
      currentTime = e.data.time * 1000;
      playing = e.data.playState;
    });
  });

  function onDrag() {
    if (locked) return;
    api.dragWindow();
  }
</script>

{#if lyricStyle}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class={cn(
      "group flex h-screen w-screen items-center justify-evenly overflow-hidden rounded-lg p-2 select-none",
      !locked && "hover:bg-black/40"
    )}
    class:cursor-grab={!locked}
    class:flex-col={!lyricStyle.vertical}
    onmousedown={onDrag}
  >
    <div
      class="flex justify-center gap-2 {api.platform === 'linux' && locked
        ? 'opacity-25 group-hover:opacity-100'
        : 'invisible group-hover:visible'} {lyricStyle.vertical
        ? 'w-12 flex-col'
        : 'h-12'}"
    >
      {#if locked}
        <button
          class="size-12 cursor-pointer"
          onclick={() => api.performAction("unlock")}
          title="解锁桌面歌词"
          {@attach inputRegionAttachment}
          ><img
            src="gui://skin/lrc/desk_icn_unlock.png"
            alt="解锁桌面歌词"
          /></button
        >
      {:else}
        {#each items as [icon, action, title, disabled] (action)}
          <IconButton
            normal={`gui://skin/lrc/${icon}_normal.svg`}
            hover={`gui://skin/lrc/${icon}_over.svg`}
            active={`gui://skin/lrc/${icon}_push.svg`}
            disable={`gui://skin/lrc/${icon}_dis.svg`}
            {disabled}
            onmousedown={(e) => {
              e.stopPropagation();
            }}
            onclick={() => api.performAction(action)}
            class="cursor-pointer"
            imgClass="size-6"
            {title}
          />
        {/each}
      {/if}
    </div>
    <LyricsComponent
      {lyrics}
      {secondaryLyrics}
      {currentTime}
      {offset}
      {lyricStyle}
      {slogan}
      {useProgress}
      class={lyricStyle.vertical ? "h-full" : "w-full"}
      style="opacity: {opacity};"
    />
  </div>
{/if}
