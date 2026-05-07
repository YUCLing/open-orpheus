<script lang="ts">
  import type { Attachment } from "svelte/attachments";
  import { onMount } from "svelte";

  import * as Popover from "$lib/components/ui/popover";
  import { Slider } from "$lib/components/ui/slider";

  import { getBridge } from "$lib/bridge";

  import IconButton from "$lib/components/IconButton.svelte";

  import type {
    MiniPlayerContract,
    MiniPlayerFullState,
    MiniPlayerPlayInfo,
    MiniPlayerPlayState,
    MiniPlayerListData,
  } from "$bridge/contracts/mini-player-api";

  const api = getBridge<MiniPlayerContract>("miniPlayer");

  let playInfo = $state<MiniPlayerPlayInfo | null>(null);
  let coverUrl = $state<string | null>(null);
  let likeMark = $state(false);
  let playState = $state<MiniPlayerPlayState>({ playing: false });
  let listData = $state<MiniPlayerListData>({ items: [], currentPlay: null });

  function applyFullState(state: MiniPlayerFullState) {
    playInfo = state.playInfo;
    coverUrl = state.coverUrl;
    likeMark = state.likeMark;
    playState = state.playState;
    listData = { items: state.listItems, currentPlay: state.currentPlay };
  }

  onMount(async () => {
    api.events.playInfoUpdate((info) => {
      playInfo = info;
    });
    api.events.coverUpdate((url) => {
      coverUrl = url;
    });
    api.events.likeUpdate((liked) => {
      likeMark = liked;
    });
    api.events.playStateUpdate((state) => {
      playState = state;
    });
    api.events.listUpdate((data) => {
      listData = data;
    });
    api.events.showVolume((data) => {
      volume = data[0] * 100;
      showVolumeBar = true;
    });
    api.events.fullStateUpdate(applyFullState);

    const state = await api.requestFullUpdate();
    if (state) {
      applyFullState(state);
    }
  });

  let inputRegionElements: Element[] = [];

  function refreshInputRegion() {
    if (api.platform === "linux") {
      api.setInputRegions(
        inputRegionElements.map((v) => {
          const bounding = v.getBoundingClientRect();
          return {
            x: bounding.left,
            y: bounding.top,
            width: bounding.width,
            height: bounding.height,
          };
        })
      );
    } else {
      // On Windows/macOS, `setIgnoreMouseEvent` is used instead of actual setting input regions
      for (const el of inputRegionElements) {
        if (el.matches(":hover")) {
          // Enable input
          api.setInputRegions([]);
          return;
        }
      }
      // Dummy region to disable input
      api.setInputRegions([{ x: 0, y: 0, width: 1, height: 1 }]);
    }
  }

  function addInputRegion(el: Element) {
    inputRegionElements.push(el);
    if (el instanceof HTMLElement) {
      el.addEventListener("mouseenter", refreshInputRegion);
      el.addEventListener("mouseleave", refreshInputRegion);
    }
    refreshInputRegion();
  }

  function removeInputRegion(el: Element) {
    inputRegionElements.splice(inputRegionElements.indexOf(el), 1);
    if (el instanceof HTMLElement) {
      el.removeEventListener("mouseenter", refreshInputRegion);
      el.removeEventListener("mouseleave", refreshInputRegion);
    }
    refreshInputRegion();
  }

  let showList = $state(false);
  let showVolumeBar = $state(false);
  let volume = $state(100);
  //let muted = $state(false);
  let volumeButtonEl: HTMLElement | undefined = $state(undefined);

  function noPropagation(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
  }

  const inputRegionAttachment: Attachment = (element) => {
    addInputRegion(element);
    return () => {
      removeInputRegion(element);
    };
  };
</script>

<Popover.Root bind:open={showVolumeBar}>
  <Popover.Content
    class="max-w-36"
    customAnchor={volumeButtonEl}
    {@attach inputRegionAttachment}
  >
    <Slider
      type="single"
      bind:value={
        () => volume,
        (v) => (
          (volume = v),
          api.fireCall("player.onminivolumechange", volume / 100)
        )
      }
      min={0}
      max={100}
      step={1}
    />
  </Popover.Content>
</Popover.Root>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex h-12.5 items-center gap-2 border border-gray-400 bg-white"
  onmousedown={(e) => {
    if (e.button != 0) return; // Only left button
    e.preventDefault();
    api.dragWindow();
  }}
  oncontextmenu={(e) => {
    e.preventDefault();
    api.fireCall("player.oncontextmenu");
  }}
  {@attach inputRegionAttachment}
>
  {#if coverUrl}
    <button
      class="cursor-pointer"
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onrequestchangetomain", "")}
    >
      <img src={coverUrl} alt="Cover" class="size-12" />
    </button>
  {/if}
  <div class="group relative flex flex-1 items-center justify-center gap-2">
    {#if playInfo}
      <div
        class="absolute top-0 right-0 bottom-0 left-0 flex flex-col justify-center bg-white text-center text-sm group-hover:hidden"
      >
        <p>{playInfo.songName}</p>
        <p class="text-gray-600">{playInfo.artistName}</p>
      </div>
    {/if}
    <IconButton
      class="size-6 cursor-pointer"
      normal="gui://skin/btn/previous.svg"
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onaction", "prev", "miniPlayer")}
    />
    <IconButton
      class="size-10 cursor-pointer"
      normal="gui://skin/btn/to{playState.playing ? 'pause' : 'play'}.svg"
      hover="gui://skin/btn/to{playState.playing ? 'pause' : 'play'}_over.svg"
      onmousedown={noPropagation}
      onclick={() =>
        api.fireCall(
          "player.onaction",
          playState.playing ? "pause" : "play",
          "miniPlayer"
        )}
    />
    <IconButton
      class="size-6 cursor-pointer"
      normal="gui://skin/btn/next.svg"
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onaction", "next", "miniPlayer")}
    />
  </div>
  <IconButton
    class="size-6 cursor-pointer"
    normal="gui://skin/btn/{likeMark ? 'loved' : 'love'}.svg"
    onmousedown={noPropagation}
    onclick={() => api.fireCall("player.onlikeclick", "normal")}
  />
  <IconButton
    bind:element={volumeButtonEl}
    class="size-6 cursor-pointer"
    normal="gui://skin/btn/voice.svg"
    onmousedown={noPropagation}
    onclick={() => api.fireCall("player.onaction", "volume", "miniPlayer")}
  />
  <IconButton
    class="size-4 cursor-pointer"
    normal="gui://skin/btn/showlist.svg"
    onmousedown={noPropagation}
    onclick={() => (showList = !showList)}
  />
  <div class="flex h-full flex-col gap-0.5 p-1">
    <IconButton
      class="size-2.5 cursor-pointer"
      normal="gui://skin/btn/close.svg"
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onrequestclose", "")}
    />
    <IconButton
      class="size-2.5 cursor-pointer"
      normal="gui://skin/btn/toweb.svg"
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onrequestchangetomain", "")}
    />
  </div>
</div>
<div
  class="invisible h-85 overflow-y-auto bg-white/85"
  class:visible={showList}
  {@attach showList && inputRegionAttachment}
>
  {#if listData.items.length > 0}
    <ul class="text-xs">
      {#each listData.items as item (item.id)}
        <li
          class="flex h-8.5 items-center select-none hover:bg-gray-400/50"
          ondblclick={() => api.fireCall("player.onrequestplay", item.id)}
          oncontextmenu={() => api.fireCall("player.onmenu", item.id)}
        >
          <div class="flex size-6 items-center justify-center">
            {#if item.id === listData.currentPlay}
              <img
                src="gui://skin/btn/list{playState.playing
                  ? 'playing'
                  : 'pause'}.svg"
                class="size-4"
                alt="Play Icon"
              />
            {/if}
          </div>
          <p>{item.title}</p>
        </li>
      {/each}
    </ul>
  {/if}
</div>
