<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";

  import type { LyricLine } from "$sharedTypes/lyrics";
  import type { LyricStyleConfig } from "$sharedTypes/desktop-lyrics";

  let {
    lyrics,
    secondaryLyrics = null,
    slogan = null,
    currentTime = 0,
    lyricStyle: style,
    class: className,
    ...rest
  }: {
    lyrics: LyricLine[] | null;
    secondaryLyrics?: LyricLine[] | null;
    currentTime: number;
    lyricStyle: LyricStyleConfig;
    slogan?: string | null;
  } & HTMLAttributes<HTMLDivElement> = $props();

  // Binary search for the current line index
  function findCurrentLineIndex(lines: LyricLine[], time: number): number {
    if (lines.length === 0) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (lines[mid].start_time <= time) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  // Find a secondary line that overlaps with a given time
  function findSecondaryLine(
    secondaryLines: LyricLine[] | null | undefined,
    time: number
  ): LyricLine | null {
    if (!secondaryLines || secondaryLines.length === 0) return null;
    const idx = findCurrentLineIndex(secondaryLines, time);
    if (idx < 0) return null;
    const line = secondaryLines[idx];
    if (time >= line.start_time && time < line.end_time) return line;
    return null;
  }

  // Compute per-line progress [0, 1]
  function lineProgress(line: LyricLine, time: number): number {
    const duration = line.end_time - line.start_time;
    if (duration <= 0) return time >= line.start_time ? 1 : 0;
    return Math.max(0, Math.min(1, (time - line.start_time) / duration));
  }

  // Compute per-word progress: returns progress percentage for the whole line
  // considering individual word timings
  function wordProgress(line: LyricLine, time: number): number {
    const words = line.words;
    if (words.length <= 1) return lineProgress(line, time);

    // Words have start_time relative to line start, so elapsed is relative too
    const elapsed = time - line.start_time;
    if (elapsed <= 0) return 0;

    // Calculate total text length for proportional mapping
    let totalLen = 0;
    for (const w of words) totalLen += w.text.length;
    if (totalLen === 0) return lineProgress(line, time);

    let filledLen = 0;
    for (const w of words) {
      const wordStart = w.start_time;
      const wordEnd = w.start_time + w.duration;
      if (elapsed >= wordEnd) {
        filledLen += w.text.length;
      } else if (elapsed > wordStart) {
        const wordProg =
          w.duration > 0 ? (elapsed - wordStart) / w.duration : 1;
        filledLen += w.text.length * wordProg;
        break;
      } else {
        break;
      }
    }
    return Math.max(0, Math.min(1, filledLen / totalLen));
  }

  let adjustedTime = $derived(currentTime + style.offset);
  let currentIdx = $derived(
    lyrics ? findCurrentLineIndex(lyrics, adjustedTime) : -1
  );

  // In double-line mode without secondary lyrics, pair lines:
  // even-indexed lines display on row 1, odd-indexed on row 2.
  // This keeps the "next line" in place when it becomes current.
  let hasSecondary = $derived(secondaryLyrics && secondaryLyrics.length > 0);

  let upperIdx = $derived.by(() => {
    if (currentIdx < 0) return -1;
    if (style.lineMode || hasSecondary) return currentIdx;
    // Pair: even indices on row 1, odd on row 2 → when lower is active, upper shows next
    // If next line doesn't exist, upper is empty (placeholder will fill)
    if (currentIdx % 2 === 0) return currentIdx;
    const nextIdx = currentIdx + 1;
    return lyrics && nextIdx < lyrics.length ? nextIdx : -1;
  });

  let lowerIdx = $derived.by(() => {
    if (currentIdx < 0) return -1;
    if (style.lineMode || hasSecondary) return -1;
    // Pair: the odd counterpart
    return currentIdx % 2 === 0 ? currentIdx + 1 : currentIdx;
  });

  // Lines to display
  let sloganLine: LyricLine | null = $derived(
    !lyrics && slogan
      ? {
          start_time: 0,
          end_time: Infinity,
          words: [{ text: slogan, start_time: 0, duration: 0 }],
        }
      : null
  );

  let primaryLine = $derived(
    lyrics && upperIdx >= 0 ? lyrics[upperIdx] : sloganLine
  );

  let secondaryLine = $derived.by(() => {
    if (!lyrics) return null;
    // Always try to find a matching secondary (translation) line
    const secLine = findSecondaryLine(secondaryLyrics, adjustedTime);
    if (secLine) return secLine;
    // In double-line mode with no secondary, show the paired line
    if (!style.lineMode && lowerIdx >= 0 && lyrics[lowerIdx]) {
      return lyrics[lowerIdx];
    }
    return null;
  });

  let primaryProgress = $derived(
    primaryLine && style.showProgress
      ? wordProgress(primaryLine, adjustedTime)
      : primaryLine
        ? 1
        : 0
  );

  let secondaryProgress = $derived.by(() => {
    if (!secondaryLine || !style.showProgress) return secondaryLine ? 1 : 0;
    // For translation lines or next lines, compute their own progress
    return wordProgress(secondaryLine, adjustedTime);
  });

  // Overflow scrolling: measure text wrapper width vs line container width
  let line1WrapperEl: HTMLDivElement | undefined = $state();
  let line2WrapperEl: HTMLDivElement | undefined = $state();
  let line1ContainerEl: HTMLDivElement | undefined = $state();
  let line2ContainerEl: HTMLDivElement | undefined = $state();
  let containerEl: HTMLDivElement | undefined = $state();

  let line1Overflow = $state(0);
  let line2Overflow = $state(0);
  let containerWidth = $state(0);
  let containerHeight = $state(0);

  // Track container resize
  $effect(() => {
    if (!containerEl) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        containerWidth = entry.contentRect.width;
        containerHeight = entry.contentRect.height;
      }
    });
    ro.observe(containerEl);
    return () => ro.disconnect();
  });

  // Re-measure overflow whenever line content, orientation, font size, or container size changes
  $effect(() => {
    void primaryLine;
    void style.vertical;
    void style.fontSize;
    void containerWidth;
    void containerHeight;
    requestAnimationFrame(() => {
      if (line1WrapperEl && line1ContainerEl) {
        const scrollDim = style.vertical
          ? line1ContainerEl.scrollHeight
          : line1ContainerEl.scrollWidth;
        const boxDim = style.vertical
          ? line1ContainerEl.clientHeight
          : line1ContainerEl.clientWidth;
        line1Overflow = Math.max(0, scrollDim - boxDim);
      } else {
        line1Overflow = 0;
      }
    });
  });

  $effect(() => {
    void secondaryLine;
    void style.vertical;
    void style.fontSize;
    void containerWidth;
    void containerHeight;
    requestAnimationFrame(() => {
      if (line2WrapperEl && line2ContainerEl) {
        const scrollDim = style.vertical
          ? line2ContainerEl.scrollHeight
          : line2ContainerEl.scrollWidth;
        const boxDim = style.vertical
          ? line2ContainerEl.clientHeight
          : line2ContainerEl.clientWidth;
        line2Overflow = Math.max(0, scrollDim - boxDim);
      } else {
        line2Overflow = 0;
      }
    });
  });

  let line1Scroll = $derived(
    line1Overflow > 0 ? line1Overflow * primaryProgress : 0
  );
  let line2Scroll = $derived(
    line2Overflow > 0 ? line2Overflow * secondaryProgress : 0
  );

  // Font style string
  let fontStyle = $derived(
    `font-family: ${style.fontFamily || "sans-serif"}; font-size: ${style.fontSize}px; font-weight: ${style.fontWeight || "normal"};`
  );

  // Gradient CSS for played/unplayed
  let gradientDir = $derived(style.vertical ? "to right" : "to bottom");
  let playedGradient = $derived(
    `linear-gradient(${gradientDir}, ${style.colorPlayedTop || "#fff"}, ${style.colorPlayedBottom || "#fff"})`
  );
  let unplayedGradient = $derived(
    `linear-gradient(${gradientDir}, ${style.colorNotPlayedTop || "#fff"}, ${style.colorNotPlayedBottom || "#fff"})`
  );

  // Text outline via multi-directional text-shadow (avoids -webkit-text-stroke crossing artifacts)
  function outlineShadow(color: string, width: number): string {
    if (!color || color === "transparent") return "";
    const w = width;
    return [
      `${w}px 0 0 ${color}`,
      `${-w}px 0 0 ${color}`,
      `0 ${w}px 0 ${color}`,
      `0 ${-w}px 0 ${color}`,
      `${w}px ${w}px 0 ${color}`,
      `${-w}px ${w}px 0 ${color}`,
      `${w}px ${-w}px 0 ${color}`,
      `${-w}px ${-w}px 0 ${color}`,
    ].join(", ");
  }

  let unplayedOutline = $derived(
    outlineShadow(style.outlineColorNotPlayed, 1.5)
  );
  let playedOutline = $derived(outlineShadow(style.outlineColorPlayed, 1.5));

  // Drop shadow
  let shadowStyle = $derived(
    style.dropShadow ? `filter: drop-shadow(${style.dropShadow});` : ""
  );
</script>

{#if lyrics || slogan}
  <div
    class="flex justify-center gap-1 overflow-hidden p-2 {style.vertical
      ? 'flex-row-reverse'
      : 'flex-col'} {className}"
    bind:this={containerEl}
    {...rest}
  >
    {#if primaryLine}
      <div
        class="relative -m-2 overflow-hidden p-2 leading-[1.3] whitespace-nowrap {style.vertical
          ? '[text-orientation:mixed] [writing-mode:vertical-rl]'
          : ''}"
        style="text-align: {line1Overflow > 0
          ? 'left'
          : style.textAlign[0]}; {fontStyle}"
        bind:this={line1ContainerEl}
      >
        <div
          class="relative inline-block will-change-transform"
          bind:this={line1WrapperEl}
          style={style.vertical
            ? `transform: translateY(-${line1Scroll}px);`
            : `transform: translateX(-${line1Scroll}px);`}
        >
          <!-- Outline layer (behind everything) -->
          {#if unplayedOutline || playedOutline}
            <span
              class="absolute top-0 left-0 inline text-transparent select-none"
              style="
                  {unplayedOutline ? `text-shadow: ${unplayedOutline};` : ''}
                  {shadowStyle}
                "
            >
              {primaryLine.words.map((w) => w.text).join("")}
            </span>
            {#if style.showProgress && playedOutline}
              <span
                class="absolute top-0 left-0 inline text-transparent will-change-[clip-path] select-none"
                style="
                    {playedOutline ? `text-shadow: ${playedOutline};` : ''}
                    clip-path: inset(0 {style.vertical
                  ? '0'
                  : `${(1 - primaryProgress) * 100}%`} {style.vertical
                  ? `${(1 - primaryProgress) * 100}%`
                  : '0'} 0);
                  "
              >
                {primaryLine.words.map((w) => w.text).join("")}
              </span>
            {/if}
          {/if}
          <!-- Unplayed fill layer -->
          <span
            class="relative inline text-transparent select-none"
            style="
                background: {unplayedGradient};
                -webkit-background-clip: text;
                background-clip: text;
                {shadowStyle}
              "
          >
            {primaryLine.words.map((w) => w.text).join("")}
          </span>
          <!-- Played fill layer (clipped) -->
          {#if style.showProgress}
            <span
              class="absolute top-0 left-0 inline text-transparent will-change-[clip-path] select-none"
              style="
                  background: {playedGradient};
                  -webkit-background-clip: text;
                  background-clip: text;
                  clip-path: inset(0 {style.vertical
                ? '0'
                : `${(1 - primaryProgress) * 100}%`} {style.vertical
                ? `${(1 - primaryProgress) * 100}%`
                : '0'} 0);
                "
            >
              {primaryLine.words.map((w) => w.text).join("")}
            </span>
          {/if}
        </div>
      </div>
    {:else if !style.lineMode}
      <div
        class="invisible leading-[1.3] {style.vertical
          ? '[writing-mode:vertical-rl]'
          : ''}"
        style={fontStyle}
      >
        &nbsp;
      </div>
    {/if}

    {#if secondaryLine}
      <div
        class="relative -m-2 overflow-hidden p-2 leading-[1.3] whitespace-nowrap {style.vertical
          ? '[text-orientation:mixed] [writing-mode:vertical-rl]'
          : ''}"
        style="text-align: {line2Overflow > 0
          ? 'left'
          : style.textAlign[1]}; {fontStyle}"
        bind:this={line2ContainerEl}
      >
        <div
          class="relative inline-block will-change-transform"
          bind:this={line2WrapperEl}
          style={style.vertical
            ? `transform: translateY(-${line2Scroll}px);`
            : `transform: translateX(-${line2Scroll}px);`}
        >
          <!-- Outline layer -->
          {#if unplayedOutline || playedOutline}
            <span
              class="absolute top-0 left-0 inline text-transparent select-none"
              style="
                  {unplayedOutline ? `text-shadow: ${unplayedOutline};` : ''}
                  {shadowStyle}
                "
            >
              {secondaryLine.words.map((w) => w.text).join("")}
            </span>
            {#if style.showProgress && playedOutline}
              <span
                class="absolute top-0 left-0 inline text-transparent will-change-[clip-path] select-none"
                style="
                    {playedOutline ? `text-shadow: ${playedOutline};` : ''}
                    clip-path: inset(0 {style.vertical
                  ? '0'
                  : `${(1 - secondaryProgress) * 100}%`} {style.vertical
                  ? `${(1 - secondaryProgress) * 100}%`
                  : '0'} 0);
                  "
              >
                {secondaryLine.words.map((w) => w.text).join("")}
              </span>
            {/if}
          {/if}
          <!-- Unplayed fill layer -->
          <span
            class="relative inline text-transparent select-none"
            style="
                background: {unplayedGradient};
                -webkit-background-clip: text;
                background-clip: text;
                {shadowStyle}
              "
          >
            {secondaryLine.words.map((w) => w.text).join("")}
          </span>
          {#if style.showProgress}
            <span
              class="absolute top-0 left-0 inline text-transparent will-change-[clip-path] select-none"
              style="
                  background: {playedGradient};
                  -webkit-background-clip: text;
                  background-clip: text;
                  clip-path: inset(0 {style.vertical
                ? '0'
                : `${(1 - secondaryProgress) * 100}%`} {style.vertical
                ? `${(1 - secondaryProgress) * 100}%`
                : '0'} 0);
                "
            >
              {secondaryLine.words.map((w) => w.text).join("")}
            </span>
          {/if}
        </div>
      </div>
    {:else if !style.lineMode}
      <div
        class="invisible leading-[1.3] {style.vertical
          ? '[writing-mode:vertical-rl]'
          : ''}"
        style={fontStyle}
      >
        &nbsp;
      </div>
    {/if}
  </div>
{/if}
