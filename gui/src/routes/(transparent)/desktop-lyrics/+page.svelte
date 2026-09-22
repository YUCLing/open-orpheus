<script lang="ts">
  import { onMount } from "svelte";
  import { createAttachmentKey } from "svelte/attachments";

  import LyricsComponent from "$lib/components/Lyrics.svelte";
  import type {
    DesktopLyricsPlayInfo,
    LyricsStyle,
  } from "@shared/types/desktop-lyrics";
  import type { Lyrics, LyricsStore } from "@shared/types/lyrics";
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
  import multihover from "$lib/multihover";
  import { onpointerdrag } from "$lib/pointer";

  const api = getBridge<DesktopLyricsContract>("desktopLyrics");

  let enableFullInteraction = $state(false);
  let enableTimer: ReturnType<typeof setTimeout> | undefined;
  let disableTimer: ReturnType<typeof setTimeout> | undefined;

  const lineHoverAttachment = multihover(
    () => {
      clearTimeout(disableTimer);
      enableTimer = setTimeout(() => {
        enableFullInteraction = true;
      }, 1000);
    },
    () => {
      clearTimeout(enableTimer);
    },
    100
  );

  let opacity = $state(1);
  let lyricStyle = $state<LyricsStyle | null>(null);

  let rawLrcLyrics: Lyrics | null = $state(null as unknown as Lyrics);
  let rawPerwordLyrics: Lyrics | null = $state(null as unknown as Lyrics);
  let translateLyrics: Lyrics | null = $state(null);
  let romaLyrics: Lyrics | null = $state(null);
  let slogan: string | null = $state(null);
  let scrollable = $derived(
    Boolean(rawLrcLyrics?.length || rawPerwordLyrics?.length)
  );
  let playInfo: DesktopLyricsPlayInfo | null = $state(null);

  let lrcLyrics = $derived.by(() =>
    insertInfoFirstLine(rawLrcLyrics, playInfo)
  );
  let perwordLyrics = $derived.by(() =>
    insertInfoFirstLine(rawPerwordLyrics, playInfo)
  );

  let currentTime = $state(0);
  let offset = $state(0);
  let playing = $state(false);
  let locked = $state(false);
  let interpolatedLyricLine = $state(true);

  let lyrics = $derived.by(() => {
    if (perwordLyrics?.length) return perwordLyrics;
    if (lrcLyrics?.length) return lrcLyrics;
    // One or both of the lyrics presents but not scrollable: render the
    // "lyrics don't scroll" fallback as the only (snippet-backed) line.
    if ((lrcLyrics || perwordLyrics) && !scrollable) {
      return [{ start_time: 0, end_time: 0, snippet: noScrollingLrc }];
    }
    return null;
  });
  let secondaryLyrics = $derived.by(() => {
    if (!lyricStyle) return null;
    if (lyricStyle.showTranslate === "translate") return translateLyrics;
    if (lyricStyle.showTranslate === "roman") return romaLyrics;
    return null;
  });
  let useProgress = $derived(perwordLyrics !== null || interpolatedLyricLine);

  // When the lyrics don't start at 0ms, prepend a synthetic first line
  // carrying the song info so something is shown from the very beginning.
  function insertInfoFirstLine(
    lyrics: Lyrics | null,
    info: DesktopLyricsPlayInfo | null
  ): Lyrics | null {
    if (!lyrics || lyrics.length === 0 || !info) return lyrics;
    if (lyrics[0].start_time > 0) {
      const text = [info.songName, info.artistName].filter(Boolean).join(" - ");
      if (!text) return lyrics;
      return [
        {
          start_time: 0,
          end_time: lyrics[0].start_time,
          words: [
            {
              text,
              start_time: 0,
              duration: lyrics[0].start_time,
            },
          ],
        },
        ...lyrics,
      ];
    }
    return lyrics;
  }

  const items: (
    [string, string, string] | [string, string, string, boolean]
  )[] = $derived([
    ["home", "detail", "打开详情页"],
    ["poffset", "offset_forward", "向前偏移歌词 0.5 秒", !scrollable],
    ["moffset", "offset_back", "向后偏移歌词 0.5 秒", !scrollable],
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

    api.events.blur(() => {
      clearTimeout(enableTimer);
      enableFullInteraction = false;
    });

    api.events.playInfoUpdate((info) => {
      playInfo = info;
    });

    api.requestFullUpdate();

    const updateLyrics = (store: LyricsStore | null) => {
      if (!store) {
        rawLrcLyrics = rawPerwordLyrics = translateLyrics = romaLyrics = null;
        return;
      }
      rawLrcLyrics = store.regular;
      rawPerwordLyrics = store["per-word"] ?? null;
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

{#snippet noScrollingLrc()}
  <!-- svelte-ignore a11y_invalid_attribute -->
  歌词不支持滚动，<a
    href="javascript:"
    onpointerdown={(e) => e.stopPropagation()}
    onclick={() => api.performAction("detail")}
    class="underline underline-offset-4">点击查看全部歌词</a
  >
{/snippet}

{#if lyricStyle}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class={cn(
      "group flex h-screen w-screen touch-none items-center justify-evenly overflow-hidden rounded-lg p-2 select-none",
      !locked && enableFullInteraction && "bg-black/40"
    )}
    class:cursor-grab={!locked}
    class:flex-col={!lyricStyle.vertical}
    {@attach onpointerdrag(onDrag)}
    onpointerenter={() => {
      clearTimeout(disableTimer);
    }}
    onpointerleave={() => {
      clearTimeout(enableTimer);
      disableTimer = setTimeout(() => {
        enableFullInteraction = false;
      }, 1000);
    }}
    onwheel={(e) => {
      e.preventDefault();
      let modifier = 0;
      if (e.shiftKey) modifier += 4;
      if (e.ctrlKey) modifier += 8;
      api.onMouseWheel(e.pageX, e.pageY, -e.deltaY, modifier);
    }}
  >
    <div
      class="flex justify-center gap-2 {locked
        ? api.platform === 'linux'
          ? 'opacity-25 group-hover:opacity-100'
          : 'invisible group-hover:visible'
        : !enableFullInteraction
          ? 'invisible'
          : ''} {lyricStyle.vertical ? 'w-12 flex-col' : 'h-12'}"
    >
      {#if locked}
        <button
          class="size-12 cursor-pointer"
          onclick={() => {
            enableFullInteraction = true;
            api.performAction("unlock");
          }}
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
            onpointerdown={(e) => {
              e.stopPropagation();
            }}
            onclick={() => api.performAction(action)}
            class={disabled ? "" : "cursor-pointer"}
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
      onlinepointerdown={() => {
        enableFullInteraction = true;
      }}
      lineattrs={{
        [createAttachmentKey()]:
          !enableFullInteraction && !locked && inputRegionAttachment,
        [createAttachmentKey()]: lineHoverAttachment,
      }}
    />
  </div>
{/if}
