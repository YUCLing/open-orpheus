<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { getBridge } from "$lib/bridge";
  import type { ManageContract } from "@shared/contracts/manage-api";

  import MessageCircleWarning from "@lucide/svelte/icons/message-circle-warning";
  import ScrollText from "@lucide/svelte/icons/scroll-text";

  const api = getBridge<ManageContract>("manage");
</script>

<h1 class="text-2xl font-bold">调试</h1>
<p class="mt-2 text-gray-700">Open Orpheus 的高级调试选项。</p>
<div class="mt-4">
  <Button
    class="cursor-pointer"
    href="https://github.com/YUCLing/open-orpheus/issues/new/choose"
    target="_blank"><MessageCircleWarning />前往报告问题</Button
  >
  <Button class="cursor-pointer" onclick={() => api.openLogFolder()}
    ><ScrollText />打开日志目录</Button
  >
</div>
<div>
  <Button variant="link" class="mt-4 cursor-pointer" onclick={() => api.gpu.openInfo()}
    >打开 chrome://gpu</Button
  >
  <Button variant="link" class="mt-4 cursor-pointer" onclick={() => api.menu.enableDefaultMenu()}
    >启用 Electron 默认菜单</Button
  >
</div>
<p class="mt-2 text-sm text-gray-400">
  Node.JS {api.versions.node} | Chromium {api.versions.chrome} | Electron {api.versions.electron}
</p>
