# 悠三堂マーケットボード

為替・株価指数・仮想通貨、日本と世界の経済・政治ニュース、自分で選んだ分野の企業の
「最新決算」と「過去10年の業績・株価」を、1画面で一覧できる投資情報ボードです。

Cloudflare Workers で動きます。Worker が外部の公開データを取得・整形・キャッシュし、
`public/index.html` がそれを表示します。データベースや API キーは不要です。

## 画面の構成

1. **為替・株価指数・商品** — ドル/円、ユーロ/円、ポンド/円、豪ドル/円、人民元/円、ユーロ/ドル、ドル指数、日経平均、S&P500、ナスダック、NYダウ、米10年債利回り、金、原油。タップで1か月〜10年のチャート。
2. **仮想通貨（円建て）** — 時価総額上位12銘柄。24時間・7日の変化率と7日間の小さな線グラフ。
3. **分野と企業** — 分野ごとのタブ。各企業カードに現在株価、直近決算（売上高・営業利益・純利益・EPSと前年比）、会社予想、10年の売上高・純利益の棒グラフ、10年の株価。「詳細・ニュース」で10年分の表と企業ニュース。分野ごとのニュースも下に出ます。
4. **ニュース** — 日本・経済／日本・政治／世界・経済／世界・政治 の4列。

## 分野と企業を変える

- **その場で変える**: 画面右上「分野と企業を編集」。書式は次のとおり。保存先はそのブラウザだけです。
  ```
  # 分野名 | ニュース検索語（省略可、OR で複数）
  7203.T トヨタ自動車
  NVDA NVIDIA
  ```
  日本株は `証券コード.T`、米国株はティッカーだけ。
- **全員の既定を変える**: `public/config.json` の `sectors` を編集して再デプロイ。為替・指数のタイルも同じファイルの `markets` で変えられます。

## データの出どころ

| 種類 | ソース | 備考 |
|---|---|---|
| 株価・為替・指数・商品・チャート | Yahoo Finance（非公式API） | 現在値は1分、チャートは15分キャッシュ |
| 日本企業の業績（10年+） | [IR BANK](https://irbank.net)（有価証券報告書） | 売上高・営業利益・純利益・EPS・配当・ROE・自己資本比率、会社予想。取れない場合は Yahoo Finance の直近4〜5期 |
| 米国企業の業績（10年+） | [SEC EDGAR](https://www.sec.gov/edgar) XBRL companyfacts | 暦年ベース。四半期も8期分 |
| 仮想通貨 | [CoinGecko](https://www.coingecko.com) | 円建て、3分キャッシュ |
| ニュース | NHK、Yahoo!ニュース、BBC、CNBC、Bloomberg、Reuters（Googleニュース経由）、Googleニュース検索 | RSS。10分キャッシュ |

いずれも公開情報の自動収集で、投資助言ではありません。遅延・欠損・誤りがありえます。

## 公開手順（初回のみ）

姉妹プロジェクト（kiroku）と同じ、GitHub → Cloudflare の自動デプロイです。

1. GitHub で新しいリポジトリを作り（例: `news_site`、Private でよい）、このフォルダの中身を置く
2. Cloudflare ダッシュボード → **Workers & Pages** → **Create** → **Workers** → **Import a repository** → このリポジトリを選ぶ → ビルド設定はそのまま **Deploy**
3. `https://yusando-news.<アカウント名>.workers.dev` で開ける
4. 独自ドメイン（`news.yusando.com`）を当てる場合: Worker の **Settings → Domains & Routes → Add → Custom domain**。DNS が Route 53 側なら、Cloudflare が案内する CNAME を Route 53 に追加

以後は GitHub のファイルを更新すれば自動で再デプロイされます。

### ローカルで動かす（任意）

Node.js 20 以上が必要です。

```bash
npx wrangler dev
```

`http://localhost:8787` で開けます。

## Google 計測・SEO（web-google-standard）

- `google-ids.json` に GA4 の測定ID（全サービス共通 `G-9JG1FFTL1B`）と広告IDを置く。`<head>` のタグは `index.html` に組み込み済みで、本番ドメイン以外では送信しないガード付き
- 成果イベント: `view_company`（企業の詳細を開く）、`view_chart`（チャートを開く）
- `robots.txt` / `sitemap.xml` / `404.html` / OGP画像（`og.png`）を `public/` に同梱

公開後にやること（ブラウザで）:
1. Search Console に `https://news.yusando.com` をURLプレフィックスで追加し、`sitemap.xml` を送信
2. GA4 のリアルタイムで自分のアクセスが出るか確認し、`view_company` と `view_chart` をキーイベントにする
3. Google 広告を使う場合は `google-ids.json` の `ads_conversion_id` とラベルを入れて再デプロイ

## ファイル

```
wrangler.toml       Worker の設定（静的ファイルは public/、/api/* は Worker）
src/worker.js       API（Yahoo / IR BANK / SEC / CoinGecko / RSS）
public/index.html   画面（依存ライブラリなし。SVG でチャート描画）
public/config.json  既定の分野・企業・市場タイル
google-ids.json     GA4・広告のID
```
