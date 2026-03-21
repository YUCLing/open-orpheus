<script module>
  type DownloadPackageProgress = {
    step: "downloading" | "extracting" | "saving" | "completed";
    downloadedBytes?: number;
    totalBytes?: number;
    progress?: number;
    file?: string;
    fileIndex?: number;
    fileCount?: number;
  };

  declare const downloadPackage: (
    callback: (progress: DownloadPackageProgress) => void
  ) => void;
</script>

<script lang="ts">
  import FileQuestionMark from "@lucide/svelte/icons/file-question-mark";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";

  type Phase = "idle" | "downloading" | "extracting" | "saving";

  let phase = $state<Phase>("idle");
  let downloadProgress = $state<DownloadPackageProgress | null>(null);

  function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function startDownload() {
    phase = "downloading";
    downloadPackage((progress) => {
      downloadProgress = progress;
      if (progress.step === "extracting") phase = "extracting";
      else if (progress.step === "saving") phase = "saving";
    });
  }
</script>

<div class="flex h-screen flex-col items-center justify-center gap-6 px-8">
  {#if phase === "idle"}
    <div class="grid grid-cols-[auto_1fr] grid-rows-2 gap-2">
      <FileQuestionMark class="row-span-2 mr-4 h-16 w-16 self-center" />
      <h1 class="self-end text-2xl font-bold">缺少包文件</h1>
      <p class="text-gray-600">所需的包文件缺失或无效。是否尝试自动下载？</p>
    </div>
    <button
      onclick={startDownload}
      class="cursor-pointer rounded-sm bg-gray-100 px-6 py-2 shadow shadow-gray-400 hover:bg-gray-200 active:bg-gray-300"
    >
      下载
    </button>
  {:else}
    <div class="flex w-full max-w-sm flex-col gap-4">
      <div class="flex items-center gap-3">
        <LoaderCircle class="h-6 w-6 shrink-0 animate-spin text-gray-500" />
        <span class="font-medium">
          {#if phase === "downloading"}
            正在下载…
          {:else if phase === "extracting"}
            正在解压…
          {:else if phase === "saving"}
            正在保存文件…
          {/if}
        </span>
      </div>

      {#if phase === "downloading" && downloadProgress}
        {@const pct =
          downloadProgress.progress != null
            ? downloadProgress.progress * 100
            : null}
        <div class="h-2 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            class="h-2 rounded-full bg-blue-500"
            style="width: {pct != null ? `${pct.toFixed(1)}%` : '0%'}"
          ></div>
        </div>
        <div class="flex justify-between text-sm text-gray-500">
          <span>{pct != null ? `${pct.toFixed(1)}%` : ""}</span>
          {#if downloadProgress.totalBytes != null}
            <span
              >{formatBytes(downloadProgress.downloadedBytes ?? 0)} / {formatBytes(
                downloadProgress.totalBytes
              )}</span
            >
          {/if}
        </div>
      {:else if phase === "extracting"}
        <div class="h-2 w-full overflow-hidden rounded-full bg-gray-200">
          <div class="h-2 w-full animate-pulse rounded-full bg-blue-500"></div>
        </div>
      {:else if phase === "saving" && downloadProgress}
        {@const idx = (downloadProgress.fileIndex ?? 0) + 1}
        {@const total = downloadProgress.fileCount ?? 1}
        <div class="h-2 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            class="h-2 rounded-full bg-blue-500 transition-all duration-150"
            style="width: {((idx / total) * 100).toFixed(1)}%"
          ></div>
        </div>
        <div class="text-right text-sm text-gray-500">
          {idx} / {total} 个文件
        </div>
      {/if}
    </div>
  {/if}
</div>
