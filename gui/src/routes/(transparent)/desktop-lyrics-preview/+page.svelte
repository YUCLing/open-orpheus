<script lang="ts">
  import { onMount, tick } from "svelte";
  import Lyrics from "$lib/components/Lyrics.svelte";
  import type { LyricLine } from "$sharedTypes/lyrics";
  import type { LyricStyleConfig } from "$sharedTypes/desktop-lyrics";
  import { getBridge } from "$lib/bridge";
  import type { DesktopLyricsPreviewContract } from "$bridge/contracts/desktop-lyrics-api";

  const api = getBridge<DesktopLyricsPreviewContract>("desktopLyricsPreview");

  function buildLyricsData(text: string): {
    lines: LyricLine[];
    secondaryLines: LyricLine[] | null;
  } {
    return {
      lines: [
        {
          start_time: 0,
          end_time: 10000,
          words: [{ text, start_time: 0, duration: 10000 }],
        },
        {
          start_time: 20000,
          end_time: 30000,
          words: [{ text, start_time: 0, duration: 10000 }],
        },
      ],
      secondaryLines: null,
    };
  }

  let lyricsData = $state(buildLyricsData("Preview"));

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
    showTranslate: "translate",
  };

  let lyricStyle: LyricStyleConfig = $state({ ...defaultStyle });

  // Double-line: line 0 fully played (time=10000), line 1 unplayed
  // Single-line: line 0 half played (time=5000)
  let currentTime = $derived(lyricStyle.lineMode ? 5000 : 10000);

  let lyricsEl: HTMLDivElement | undefined = $state();
  let scale = $state(1);

  function fitScale() {
    if (!lyricsEl) return;
    // Reset scale to measure natural size
    scale = 1;
    requestAnimationFrame(() => {
      if (!lyricsEl) return;
      const sw = window.innerWidth / lyricsEl.scrollWidth;
      const sh = window.innerHeight / lyricsEl.scrollHeight;
      scale = Math.min(sw, sh);
    });
  }

  onMount(async () => {
    const { style, text } = await api.requestInit();
    lyricsData = buildLyricsData(text);
    lyricStyle = {
      ...lyricStyle,
      ...style,
      offset: 0,
      showProgress: true,
    };
    await tick();
    fitScale();
    await tick();
    setTimeout(() => api.ready(), 10);
  });
</script>

<div
  class="fixed inset-0 flex h-screen w-screen items-center justify-center overflow-hidden"
>
  <div
    bind:this={lyricsEl}
    style="transform: scale({scale}); transform-origin: center center;"
  >
    <Lyrics
      lyrics={lyricsData.lines}
      secondaryLyrics={lyricsData.secondaryLines}
      {currentTime}
      {lyricStyle}
    />
  </div>
</div>
