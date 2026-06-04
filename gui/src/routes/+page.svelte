<script lang="ts">
  import * as Sidebar from "$lib/components/ui/sidebar";
  import * as Dialog from "$lib/components/ui/dialog";

  import type { UpdateInfo } from "$sharedTypes/update";
  import UpdateIcon from "@lucide/svelte/icons/circle-fading-arrow-up";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";

  import Logo from "../../../assets/icon.svg";

  import { getBridge } from "$lib/bridge";
  import type { ManageContract } from "$bridge/contracts/manage-api";

  const api = getBridge<ManageContract>("manage");

  import GitHub from "$lib/assets/GitHub_Invertocat_Black_Clearspace.svg";

  const socials = [
    {
      name: "GitHub",
      link: "https://github.com/YUCLing/open-orpheus",
      icon: GitHub,
    },
  ];

  import PackageIcon from "@lucide/svelte/icons/package";
  import Package from "./Package.svelte";

  import CableIcon from "@lucide/svelte/icons/cable";
  import Protocol from "./Protocol.svelte";

  import Database from "@lucide/svelte/icons/database";
  import LocalResources from "./LocalResources.svelte";

  import AppWindow from "@lucide/svelte/icons/app-window";
  import Window from "./Window.svelte";

  import QuoteIcon from "@lucide/svelte/icons/quote";
  import DesktopLyrics from "./DesktopLyrics.svelte";

  import TableOfContents from "@lucide/svelte/icons/table-of-contents";
  import Tray from "./Tray.svelte";

  import Bug from "@lucide/svelte/icons/bug";
  import Debug from "./Debug.svelte";
  import { Button } from "$lib/components/ui/button";

  const items = [
    {
      id: "package",
      name: "资源包",
      icon: PackageIcon,
      component: Package,
    },
    {
      id: "protocol",
      name: "协议处理",
      icon: CableIcon,
      component: Protocol,
    },
    {
      id: "local-resources",
      name: "本地资源",
      icon: Database,
      component: LocalResources,
    },
    {
      id: "window",
      name: "窗口设置",
      icon: AppWindow,
      component: Window,
    },
    {
      id: "desktop-lyrics",
      name: "桌面歌词",
      icon: QuoteIcon,
      component: DesktopLyrics,
    },
    api.platform === "linux"
      ? {
          id: "tray",
          name: "托盘菜单",
          icon: TableOfContents,
          component: Tray,
        }
      : undefined,
    {
      id: "debug",
      name: "调试",
      icon: Bug,
      component: Debug,
    },
  ];

  const shownItems = $derived(items.filter((v) => v !== undefined));

  let updateInfoPromise: Promise<UpdateInfo | null> = $state(api.checkUpdate());
  let showUpdateDialog = $state(false);
</script>

<Dialog.Root bind:open={showUpdateDialog}>
  <Dialog.Content>
    {#await updateInfoPromise then updateInfo}
      {#if updateInfo}
        <Dialog.Title class="text-xl">发现新版本 Open Orpheus</Dialog.Title>
        <Dialog.Description>
          <p>
            Open Orpheus 已更新到 <b>{updateInfo.version}</b
            >。建议您更新以获得最佳体验。
          </p>
          <p class="mt-4 text-right">
            <Button variant="link" href={updateInfo.url} target="_blank"
              >查看详细信息</Button
            >
          </p>
        </Dialog.Description>
      {/if}
    {/await}
  </Dialog.Content>
</Dialog.Root>

<Sidebar.Provider>
  <Sidebar.Root
    collapsible="none"
    class="h-screen min-w-64 border-r-2 border-gray-200/50"
  >
    <Sidebar.Header>
      <Sidebar.Menu>
        <Sidebar.MenuItem>
          <Dialog.Root>
            <Dialog.Trigger>
              {#snippet child({ props })}
                <Sidebar.MenuButton
                  {...props}
                  class="grid h-auto cursor-pointer grid-cols-[auto_1fr] grid-rows-[auto_auto] gap-0"
                >
                  <img
                    src={Logo}
                    alt="Logo"
                    class="row-span-2 mr-2 h-10 w-10 self-center"
                  />
                  <h1 class="text-xl font-bold">Open Orpheus</h1>
                  <p class="text-xs opacity-75">v{__APP_VERSION__}</p>
                </Sidebar.MenuButton>
              {/snippet}
            </Dialog.Trigger>
            <Dialog.Content>
              <div class="text-center">
                <img src={Logo} alt="Logo" class="m-auto h-24 w-24" />
                <h1 class="text-3xl font-bold">Open Orpheus</h1>
                <p class="mt-2">
                  v{__APP_VERSION__}<Button
                    variant="ghost"
                    size="icon-xs"
                    class="ml-2 cursor-pointer"
                    title="检查更新"
                    onclick={() => (updateInfoPromise = api.checkUpdate(true))}
                    ><RefreshCw /></Button
                  >
                </p>
              </div>
              <div class="flex justify-center">
                {#each socials as social (social.name)}
                  <a
                    href={social.link}
                    target="_blank"
                    title={social.name}
                    rel="external"
                    class="block opacity-75 hover:opacity-100"
                  >
                    <img src={social.icon} alt={social.name} class="h-8 w-8" />
                  </a>
                {/each}
              </div>
              <div class="text-center">
                <p>
                  Open Orpheus
                  是一个以互操作性为目的的独立开源项目，与网易公司没有任何关联、授权或认可关系。
                </p>
                <p>"网易云音乐"、"Orpheus" 等名称及相关商标归网易公司所有。</p>
              </div>
              <div class="text-center">
                <p>
                  Open Orpheus 的诞生离不开 <Button
                    class="px-0"
                    target="_blank"
                    href="https://www.chromium.org/"
                    variant="link">Chromium</Button
                  > 开源项目以及其他<Button
                    class="px-0"
                    target="_blank"
                    href="https://github.com/YUCLing/open-orpheus/releases/download/v{__APP_VERSION__}/LICENSES.chromium.{api.platform}.html"
                    variant="link">开源软件</Button
                  >。
                </p>
              </div>
            </Dialog.Content>
          </Dialog.Root>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.Header>
    <Sidebar.Content>
      <Sidebar.Group>
        <Sidebar.GroupContent>
          <Sidebar.Menu>
            {#each shownItems as item (item.id)}
              <Sidebar.MenuItem>
                <Sidebar.MenuButton>
                  {#snippet child({ props })}
                    <a href="#{item.id}" {...props}><item.icon />{item.name}</a>
                  {/snippet}
                </Sidebar.MenuButton>
              </Sidebar.MenuItem>
            {/each}
          </Sidebar.Menu>
        </Sidebar.GroupContent>
      </Sidebar.Group>
    </Sidebar.Content>
    {#await updateInfoPromise then updateInfo}
      {#if updateInfo}
        <Sidebar.Footer>
          <Sidebar.Menu>
            <Sidebar.MenuItem>
              <Sidebar.MenuButton
                class="cursor-pointer text-orange-600 hover:text-orange-800"
                onclick={() => (showUpdateDialog = true)}
              >
                <UpdateIcon />有新版本
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          </Sidebar.Menu>
        </Sidebar.Footer>
      {/if}
    {/await}
  </Sidebar.Root>
  <main class="h-screen flex-1 overflow-y-auto">
    <div class="w-full p-4 xl:mx-auto xl:w-4xl">
      {#each shownItems as item, i (item.id)}
        <div class="my-4" class:mt-0={i === 0} id={item.id}>
          <item.component />
        </div>
        {#if i < items.length - 1}
          <hr class="my-6 border-t-2 border-gray-200/50" />
        {/if}
      {/each}
    </div>
  </main>
</Sidebar.Provider>
