<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button, buttonVariants } from "$lib/components/ui/button";
  import { getBridge } from "$lib/bridge";
  import type { ManageContract } from "$bridge/manage-api";

  const api = getBridge<ManageContract>("manage");

  import versions from "../../../versions.json";
  import { cn } from "$lib/utils";
</script>

<h1 class="text-2xl font-bold">资源包</h1>
<p class="mt-2 text-gray-700">
  一个 Open Orpheus 版本仅为一个特定的资源包版本设计，因此推荐使用与当前 Open
  Orpheus 版本匹配的资源包版本以获得最佳体验。
</p>
<p class="mt-4 text-gray-700">
  {#await api.pack.getWebPackCommitHash()}
    推荐资源包版本：{versions.commit}
  {:then commitHash}
    当前资源包版本：{commitHash}{#if commitHash === versions.commit}（已是推荐版本）{:else}（推荐使用
      {versions.commit}）{/if}
  {/await}
</p>

<Dialog.Root>
  <Dialog.Trigger
    type="button"
    class={cn(buttonVariants({ variant: "default" }), "mt-4 cursor-pointer")}
  >
    重新下载资源包
  </Dialog.Trigger>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>确认重新下载推荐资源包</Dialog.Title>
      <Dialog.Description
        >重新下载推荐资源包将需要重启 Open
        Orpheus，当前版本资源包将被删除。确定吗？</Dialog.Description
      >
    </Dialog.Header>
    <Dialog.Footer>
      <Button
        variant="destructive"
        class="cursor-pointer"
        onclick={() => api.pack.redownloadPackage()}>确定</Button
      >
      <Dialog.Close
        type="button"
        class={cn(buttonVariants({ variant: "outline" }), "cursor-pointer")}
      >
        取消
      </Dialog.Close>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
