import { registerCallHandler } from "../calls";
import { fireNativeCall } from "../channel";
import type YunxinIM from "../YunxinIM";

let im: YunxinIM | null = null;

registerCallHandler<
  [
    {
      chat_roomid: string;
    },
  ],
  void
>("im.enter", (params) => {
  void (async () => {
    if (!im) {
      // Lazy load SDK
      im = new (await import("../YunxinIM")).default();
      im.addEventListener("chatroommsg", (e) => {
        const msg = (e as CustomEvent<string | undefined>).detail;
        fireNativeCall("im.onChatRoomMsg", { msg });
      });
    }
    await im.connect();
    await im.joinRoom(params.chat_roomid);
    fireNativeCall("im.onEnter", { code: 200 });
  })();
});

registerCallHandler<[], void>("im.leave", async () => {
  if (!im) return;
  await im.leaveRoom();
  await im.disconnect();
});
