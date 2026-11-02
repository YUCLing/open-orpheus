<script lang="ts">
  import type { ManageContract } from "@shared/contracts/manage-api";
  import { getBridge } from "$lib/bridge";
  import { Button } from "$lib/components/ui/button";

  const api = getBridge<ManageContract>("manage");

  let isClientPromise = $state(api.protocol.isClient());
  let clientNamePromise = $state(api.protocol.getClientName());
</script>

<h1 class="text-2xl font-bold">协议处理</h1>
<p class="mt-2 text-gray-700">
  Open Orpheus 可以被注册为网易云音乐 URL 协议客户端，以响应网页端的唤起。
</p>

{#await isClientPromise}
  <p class="mt-4 text-gray-700">请稍候...</p>
{:then isClient}
  {#if isClient}
    <p class="my-4 text-gray-700">当前已是网易云音乐 URL 协议客户端。</p>
    {#if api.platform !== "linux"}
      <!-- Unregistering is impossible on Linux -->
      <Button
        onclick={async () => {
          await api.protocol.setAsClient(false);
          [isClientPromise, clientNamePromise] = [
            api.protocol.isClient(),
            api.protocol.getClientName(),
          ];
        }}>取消注册</Button
      >
    {/if}
  {:else}
    <p class="my-4 text-gray-700">当前不是网易云音乐 URL 协议客户端。</p>
    <Button
      onclick={async () => {
        await api.protocol.setAsClient(true);
        isClientPromise = api.protocol.isClient();
      }}>注册为客户端</Button
    >
    {#await clientNamePromise then name}
      <p class="text-sm text-gray-700">注册将会替换 {name}。</p>
    {/await}
  {/if}
{/await}
