# MAS SGD Exchange Rates

This is the dark MAS dashboard with the original two-column layout, Newsreader headings and rate figures, and Arial interface text. The Vercel Function at `/api/rates` retrieves the official MAS publication. Daily and month-end rates, historical lookup, refresh, search, conversion, swapping and CSV export use the same dashboard as the published ChatGPT Site.

## Deploy on Vercel

1. Extract the ZIP and open the `mas-sgd-rates-vercel` folder. It contains `vercel.json`, `api/`, `lib/`, and `public/`.
2. Run `npx vercel@latest --prod` in that folder. Follow the prompts to sign into Vercel and create or select a Vercel project. Alternatively, push the extracted project to a Git repository and import it into Vercel using **Other** as the framework preset.
3. Open the production URL Vercel returns. For public access, check the production URL in a private browser window. If it asks visitors to sign in, check the project's **Settings → Deployment Protection**.

The included configuration serves `public/` at the root and runs `api/rates.ts` as a Node.js function. The import needs no environment variables, MAS API key, or ChatGPT credentials. Vercel account access is only needed to manage the deployment.

## Edit the source

| File | What it controls |
| --- | --- |
| `public/index.html` | Dashboard layout and browser interactions |
| `public/dashboard.css` | Dark theme, typography and responsive layout |
| `api/rates.ts` | The `/api/rates` HTTP endpoint |
| `lib/mas-rates.ts` | Server-side MAS download, CSV parsing, date validation and caching |

To preview the dashboard and function together before deployment, run `npx vercel@latest dev` using Node.js 24. A static-only preview will display the layout but cannot fetch rates without the function. After deploying, visit `/api/rates?period=daily` on your Vercel URL to check the MAS connection.

[Official MAS exchange-rate publication](https://eservices.mas.gov.sg/statistics/msb/ExchangeRates.aspx)

Newsreader is included under the SIL Open Font License. See `public/fonts/newsreader-OFL.txt`.
