<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { getBridge } from "$lib/bridge";
  import type { ManageContract } from "$bridge/contracts/manage-api";

  const api = getBridge<ManageContract>("manage");
</script>

<h1 class="text-2xl font-bold">调试</h1>
<p class="mt-2 text-gray-700">Open Orpheus 的高级调试选项。</p>
<Button class="mt-4" onclick={() => api.gpu.openInfo()}
  >打开 chrome://gpu</Button
>
<Button class="mt-4" onclick={() => api.menu.enableDefaultMenu()}
  >启用 Electron 默认菜单</Button
>
<p class="mt-2 text-sm text-gray-400">
  Node.JS {api.versions.node} | Chromium {api.versions.chrome} | Electron {api
    .versions.electron}
</p>
