const STOP_WORDS_ZH = new Set([
  "帮我", "可以", "怎么", "什么", "一个", "这个", "那个", "就是",
  "有没有", "能不能", "我想", "你好", "谢谢", "请问", "好的", "嗯",
  "的", "了", "在", "是", "我", "你", "他", "她", "它", "们",
  "不", "也", "都", "和", "与", "或", "但", "而",
]);

const STOP_WORDS_EN = new Set([
  "the", "and", "for", "that", "this", "with", "are", "was", "were",
  "been", "have", "has", "had", "not", "but", "all", "can", "her",
  "his", "its", "may", "you", "your", "how", "what", "when", "who",
  "will", "from", "each", "which", "their", "them", "then", "than",
  "about", "would", "could", "should", "there", "these", "those",
  "please", "help", "want", "need", "just", "like", "know",
]);

/**
 * Extract top topics from conversation messages using simple keyword frequency.
 * @param {{ role: string, content: string | any }[]} messages
 * @param {number} topN - Number of top topics to return (default 5)
 * @returns {{ topic: string, count: number }[]}
 */
export function extractTopics(messages, topN = 5) {
  const text = messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ");

  // Extract Chinese words (2-4 chars) and English words (3+ chars)
  const zhWords = text.match(/[\u4e00-\u9fff]{2,4}/g) || [];
  const enWords = text.match(/[a-zA-Z]{3,}/g) || [];

  const freq = {};
  for (const w of zhWords) {
    if (!STOP_WORDS_ZH.has(w)) {
      freq[w] = (freq[w] || 0) + 1;
    }
  }
  for (const w of enWords) {
    const lower = w.toLowerCase();
    if (!STOP_WORDS_EN.has(lower)) {
      freq[lower] = (freq[lower] || 0) + 1;
    }
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([topic, count]) => ({ topic, count }));
}

// ── Self-test when run directly ──────────────
if (process.argv[1] && process.argv[1].endsWith("keywords.js")) {
  console.log("\n🧪 keywords.js self-test\n");
  const testMessages = [
    { role: "user", content: "帮我查一下深度学习的最新论文" },
    { role: "assistant", content: "好的，我来帮你查找..." },
    { role: "user", content: "深度学习和机器学习有什么区别" },
    { role: "user", content: "Python怎么安装TensorFlow" },
    { role: "user", content: "Tell me about React hooks and useState" },
  ];
  const topics = extractTopics(testMessages);
  console.log("Topics:", topics);
  console.log(topics.length > 0 ? "✅ PASSED" : "❌ FAILED");
}
