import test from "ava";

test("module can load", async (t) => {
  await t.notThrowsAsync(async () => {
    await import("../index");
  });
});
