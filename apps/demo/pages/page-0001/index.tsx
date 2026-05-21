import { BilingualPage } from '@interlinear/core';

export default function Page0001() {
  return (
    <BilingualPage
      originalSrc="/page-0001.png"
      pageLabel="page 1"
      footerLeft="1"
      footerCenter="Example Doc"
      footerRight="Page 1"
    >
      <h1 className="font-display text-[24px] font-semibold tracking-[-0.005em] mt-2 mb-3 text-ink">
        1. 簡介
      </h1>
      <p className="mb-4 text-ink leading-relaxed">
        本頁是 interlinear demo 的合成範例頁。框架本身不綁定任何第三方文件，這頁的存在
        只是為了讓你看到雙語版面的渲染、檢查器互動，以及鍵盤導覽。
      </p>
      <p className="mb-4 text-ink leading-relaxed">
        在右側譯文窗格的任一段文字上點一下，就會打開檢查器面板：可以直接修改譯文存回原始碼，
        或留下 marker 給 agent 處理。鍵盤上按 <code className="font-mono text-[12.5px] text-accent">j</code> /
        <code className="font-mono text-[12.5px] text-accent">k</code> 翻頁，按
        <code className="font-mono text-[12.5px] text-accent">/</code> 可快速跳頁。
      </p>

      <h2 className="font-display text-[16px] font-semibold mt-6 mb-2 text-ink uppercase tracking-[0.06em]">
        1.1 範例列點
      </h2>
      <ul className="mb-4 list-disc list-inside text-ink leading-relaxed">
        <li>原始頁面渲染在左側。</li>
        <li>翻譯內容存成可被 agent 編輯的 TSX 在右側。</li>
        <li>Dev server 在每次編輯後熱重載。</li>
      </ul>

      <h2 className="font-display text-[16px] font-semibold mt-6 mb-2 text-ink uppercase tracking-[0.06em]">
        1.2 程式碼區塊
      </h2>
      <pre
        className="font-mono text-[11.5px] leading-snug px-3 py-2 mb-4 overflow-x-auto text-ink"
        style={{ background: 'var(--color-paper-deep)', borderLeft: '3px solid var(--color-ink)' }}
      >
        <code>{`def example():\n    return "hello"`}</code>
      </pre>
    </BilingualPage>
  );
}
