import { BilingualPage } from '@interlinear/core';

const TD = 'border border-ink/40 px-3 py-2 align-top text-[13px] text-ink';
const TD_MONO = 'border border-ink/40 px-3 py-2 align-top font-mono text-[12.5px] text-ink';
const TH =
  'border border-ink px-3 py-2 font-mono text-[11px] font-semibold text-left uppercase tracking-[0.06em] bg-paper-deep text-ink';

const EXAMPLE_CODE = `const config = {
  mode: "strict",
  retries: 3,
};

runner.start(config);`;

export default function Page0001() {
  return (
    <BilingualPage
      originalSrc="/example/page-0001.png"
      pageLabel="page 1"
      footerLeft="1"
      footerCenter="Example Doc"
      footerRight="Page 1"
    >
      <h1 className="font-display text-[24px] font-semibold tracking-[-0.005em] mt-2 mb-3 text-ink">
        1. 設定
      </h1>
      <p className="mb-5 text-ink leading-relaxed">
        本章描述範例設定檔的格式。每一筆設定都遵循同樣的結構：模式名稱、宣告的型別、
        預設值，以及使用上的注意事項。
      </p>

      <h2 className="font-display text-[15px] font-semibold mt-6 mb-3 text-ink uppercase tracking-[0.06em]">
        1.1　模式對照表
      </h2>

      <div className="overflow-x-auto mb-6">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH}>模式</th>
              <th className={TH}>型別</th>
              <th className={TH}>預設值</th>
              <th className={TH}>說明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={TD_MONO}>normal</td>
              <td className={TD_MONO} rowSpan={2}>
                string
              </td>
              <td className={TD_MONO}>"auto"</td>
              <td className={TD}>標準路徑。</td>
            </tr>
            <tr>
              <td className={TD_MONO}>strict</td>
              <td className={TD_MONO}>—</td>
              <td className={TD}>強制檢查。</td>
            </tr>
            <tr>
              <td className={TD_MONO}>quiet</td>
              <td className={TD_MONO}>bool</td>
              <td className={TD_MONO}>false</td>
              <td className={TD}>抑制警告訊息。</td>
            </tr>
            <tr>
              <td className={TD_MONO}>silent</td>
              <td
                className={`${TD} italic text-ink-muted font-body`}
                colSpan={3}
              >
                <code className="font-mono text-[12.5px] text-accent">quiet</code>
                {' '}的舊別名 — 將於下版本移除。
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className="font-display text-[15px] font-semibold mt-6 mb-3 text-ink uppercase tracking-[0.06em]">
        1.2　範例程式
      </h2>
      <p className="mb-3 text-ink leading-relaxed">
        以下範例展示如何用
        <code className="font-mono text-[12.5px] text-accent">strict</code>
        {' '}模式啟動 runner：
      </p>
      <pre
        className="font-mono text-[11.5px] leading-snug px-3 py-2 mb-6 overflow-x-auto text-ink"
        style={{
          background: 'var(--color-paper-deep)',
          borderLeft: '3px solid var(--color-ink)',
        }}
      >
        <code>{EXAMPLE_CODE}</code>
      </pre>

      <h2 className="font-display text-[15px] font-semibold mt-6 mb-3 text-ink uppercase tracking-[0.06em]">
        1.3　注意事項
      </h2>

      <blockquote
        className="mb-5 px-4 py-3 text-ink leading-relaxed"
        style={{
          background: 'var(--color-warn-soft)',
          borderLeft: '3px solid var(--color-warn)',
        }}
      >
        模式在啟動時就會被檢查。若值不合法，程式會在任何工作開始之前中止。
      </blockquote>

      <dl className="mb-4">
        <dt className="font-mono text-[13px] text-accent mt-2">retries</dt>
        <dd className="ml-6 mb-2 text-ink leading-relaxed">
          遇到短暫故障時要重試的次數。
        </dd>
        <dt className="font-mono text-[13px] text-accent mt-2">timeout</dt>
        <dd className="ml-6 mb-2 text-ink leading-relaxed">
          單次請求的逾時時間，單位毫秒。
        </dd>
      </dl>
    </BilingualPage>
  );
}
