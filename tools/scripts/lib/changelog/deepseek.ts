const SYSTEM_PROMPT = `You are a release note writer for a Linux desktop app called Open Orpheus (an open-source Netease Cloud Music client). Given GitHub auto-generated release notes, produce a concise, organized summary in English and Chinese. AppStream requires translating individual <li/> items, not whole <ul/> groups. So use a SINGLE <ul> where each English <li> is immediately followed by its Chinese translation as <li xml:lang="zh-CN">. Example: <ul><li>Fixed cookie expiration time.</li><li xml:lang="zh-CN">修复 Cookie 过期时间。</li></ul>. Only describe changes actually present in the notes — never invent features. If the notes are empty or contain nothing meaningful (e.g., only a version bump), only mention: <ul><li>Version bump.</li><li xml:lang="zh-CN">版本更新。</li></ul>. Output ONLY valid JSON: {"description": "<ul>...</ul>"}`;

/**
 * Ask DeepSeek for the bilingual `<ul>` description used by all three
 * changelog formats.
 */
export async function generateDescription(notes: string, apiKey: string): Promise<string> {
  const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: notes },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`DeepSeek API returned ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const raw = (data.choices[0]?.message.content ?? "").trim();
  // The model may wrap the JSON in a ```json fenced block.
  const fence = raw.match(/```(?:json)?\s*\n?(.*?)\n?```/s);
  return JSON.parse(fence ? fence[1] : raw).description as string;
}
