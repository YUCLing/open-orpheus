<script lang="ts">
  import { onMount } from "svelte";
  import Lyrics from "$lib/components/Lyrics.svelte";
  import type { LyricsData, LyricStyleConfig } from "$lib/types";
  import IconButton from "$lib/components/IconButton.svelte";
  import { cn } from "$lib/utils";
  import { getBridge } from "$lib/bridge";
  import type { DesktopLyricsContract } from "$bridge/contracts/desktop-lyrics-api";
  import { inputRegionAttachment } from "$lib/inputRegion";

  const api = getBridge<DesktopLyricsContract>("desktopLyrics");

  let lyricsData: LyricsData | null = $state(null);
  let currentTime = $state(0);
  let playing = $state(false);
  let locked = $state(false);
  let unlockButton: HTMLButtonElement | null = $state(null);
  let rootEl: HTMLDivElement | null = $state(null);

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

  const defaultStyle: LyricStyleConfig = {
    fontFamily: "sans-serif",
    fontSize: 36,
    fontWeight: "normal",
    textAlign: ["center", "center"],
    lineMode: false,
    vertical: false,
    colorNotPlayedTop: "#ffffff",
    colorNotPlayedBottom: "#cccccc",
    colorPlayedTop: "#00ff88",
    colorPlayedBottom: "#00cc66",
    outlineColorNotPlayed: "transparent",
    outlineColorPlayed: "transparent",
    dropShadow: "0 2px 4px rgba(0,0,0,0.5)",
    showProgress: true,
    offset: 0,
    slogan: "",
  };

  let lyricStyle: LyricStyleConfig = $state({ ...defaultStyle });

  // rAF time interpolation
  let lastKnownTime = 0;
  let lastUpdateTimestamp = 0;
  let rafId: number | null = null;

  function rafLoop() {
    if (!playing) return;
    const elapsed = performance.now() - lastUpdateTimestamp;
    currentTime = lastKnownTime + elapsed;
    rafId = requestAnimationFrame(rafLoop);
  }

  function startRaf() {
    if (rafId !== null) return;
    lastUpdateTimestamp = performance.now();
    rafId = requestAnimationFrame(rafLoop);
  }

  function stopRaf() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // svelte-ignore state_referenced_locally
  let previousVertical = lyricStyle.vertical;
  $effect(() => {
    if (lyricStyle.vertical !== previousVertical) {
      previousVertical = lyricStyle.vertical;
      api.changeOrientation();
    }
  });

  onMount(() => {
    api.events.lyricsUpdate((data) => {
      lyricsData = data;
    });

    api.events.timeUpdate((data) => {
      lastKnownTime = data.currentTime;
      lastUpdateTimestamp = performance.now();
      currentTime = data.currentTime;

      if (data.playing !== playing) {
        playing = data.playing;
        if (playing) startRaf();
        else stopRaf();
      }
    });

    api.events.styleUpdate((data) => {
      lyricStyle = { ...lyricStyle, ...data };
    });

    api.events.playStateChange((isPlaying) => {
      playing = isPlaying;
      if (playing) {
        lastUpdateTimestamp = performance.now();
        startRaf();
      } else {
        stopRaf();
      }
    });

    api.events.setLocked((isLocked) => {
      locked = isLocked;
    });

    api.requestFullUpdate();

    return () => stopRaf();
  });

  function onDrag() {
    if (locked) return;
    api.dragWindow();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={rootEl}
  class={cn(
    "group flex h-screen w-screen items-center justify-evenly overflow-hidden rounded-lg p-2 select-none",
    !locked && "hover:bg-black/40"
  )}
  class:cursor-grab={!locked}
  class:flex-col={!lyricStyle.vertical}
  onmousedown={onDrag}
>
  <div
    class="flex justify-center gap-2 group-hover:visible invisible{lyricStyle.vertical
      ? ' flex-col'
      : ''}"
  >
    {#if locked}
      <button
        bind:this={unlockButton}
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
          disabled={disabled ? `gui://skin/lrc/${icon}_dis.svg` : undefined}
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
  <Lyrics
    {lyricsData}
    {currentTime}
    {lyricStyle}
    class={lyricStyle.vertical ? "h-full" : "w-full"}
  />
</div>
