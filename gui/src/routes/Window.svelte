<script lang="ts">
  import * as RadioGroup from "$lib/components/ui/radio-group";
  import * as Field from "$lib/components/ui/field";

  import * as settings from "$lib/settings";

  let overrideMainWindowSizeLimitPromise = $state(
    settings.get("window.overrideMainWindowSizeLimit")
  );
  let windowLifecyclePromise = $state(settings.get("window.lifecycle"));
</script>

<h1 class="text-2xl font-bold">窗口设置</h1>
<p class="mt-2 text-gray-700">控制 Open Orpheus 的窗口管理行为。</p>

<div class="my-4">
  <h2 class="text-lg font-bold">主窗口大小限制</h2>
  <p class="mt-2 text-sm text-gray-700">
    网易云音乐会对主窗口添加大小限制，如果你想让主窗口的大小能够更加灵活地调整，你可以在这移除限制。
  </p>

  {#await overrideMainWindowSizeLimitPromise then value}
    <RadioGroup.Root
      class="mt-2"
      bind:value={
        () => (value as string) || "false",
        (v) => {
          settings.set("window.overrideMainWindowSizeLimit", v);
          overrideMainWindowSizeLimitPromise = Promise.resolve(v);
        }
      }
    >
      <Field.Label for="main-window-size-limit-false">
        <Field.Field orientation="horizontal">
          <Field.Content>
            <Field.Title>正常应用限制</Field.Title>
            <Field.Description>
              主窗口将遵循网易云音乐设置的大小限制。
            </Field.Description>
          </Field.Content>
          <RadioGroup.Item id="main-window-size-limit-false" value="false" />
        </Field.Field>
      </Field.Label>
      <Field.Label for="main-window-size-limit-true">
        <Field.Field orientation="horizontal">
          <Field.Content>
            <Field.Title>不应用限制</Field.Title>
            <Field.Description>主窗口将没有大小限制。</Field.Description>
          </Field.Content>
          <RadioGroup.Item id="main-window-size-limit-true" value="true" />
        </Field.Field>
      </Field.Label>
    </RadioGroup.Root>
  {/await}
</div>

<div class="my-4">
  <h2 class="text-lg font-bold">窗口生命周期</h2>
  <p class="mt-2 text-sm text-gray-700">
    非必要窗口（如桌面歌词、迷你播放器）在后台隐藏时仍会占用内存，你可以在这里调整这些窗口的生命周期管理模式。修改此设置需要重启应用才能生效。
  </p>

  {#await windowLifecyclePromise then value}
    <RadioGroup.Root
      class="mt-2"
      bind:value={
        () => (value as string) || "on-demand",
        (v) => {
          settings.set("window.lifecycle", v);
          windowLifecyclePromise = Promise.resolve(v);
        }
      }
    >
      <Field.Label for="lifecycle-on-demand">
        <Field.Field orientation="horizontal">
          <Field.Content>
            <Field.Title>按需加载</Field.Title>
            <Field.Description>
              窗口只会在使用时被创建，不使用时完全销毁释放内存，但每次重新创建可能会带来一定延迟。
            </Field.Description>
          </Field.Content>
          <RadioGroup.Item id="lifecycle-on-demand" value="on-demand" />
        </Field.Field>
      </Field.Label>
      <Field.Label for="lifecycle-hide-only">
        <Field.Field orientation="horizontal">
          <Field.Content>
            <Field.Title>仅隐藏</Field.Title>
            <Field.Description
              >窗口在不使用时只进行隐藏，会占用内存，但操作响应较快。</Field.Description
            >
          </Field.Content>
          <RadioGroup.Item id="lifecycle-hide-only" value="hide-only" />
        </Field.Field>
      </Field.Label>
    </RadioGroup.Root>
  {/await}
</div>
