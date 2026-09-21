# CNCVEYRA — "veyra" Worker Deploy Guide (Hinglish)

## Pehle: kya badla?

Tumne pehle jo `veyra` Worker banaya tha, usme site (index.html) aur
backend dono ek saath the, lekin backend ka code (`generate-turning.js`)
**Cloudflare Pages** ke format mein likha hua tha — Worker mein wo format
support nahi karta, isliye "Backend se contact nahi ho paaya" wala error
aa raha tha.

Ab maine poora project ek **single Cloudflare Worker** ke liye theek se
bana diya hai — same jaisa tumhara existing `veyra` Worker hai. Isme:

```
veyra-worker/
├── wrangler.toml        ← Worker ka config (naam "veyra" hi rakha hai)
├── package.json
├── public/
│   ├── index.html        ← tumhari site (backend URL ab relative hai)
│   └── cncveyralive.html
└── src/
    ├── index.js           ← Worker ka entry point (routing)
    └── logic.js           ← Asli G-code generation logic (private)
```

`index.html` ab `/api/generate-turning` (same domain, relative path) ko
call karta hai — koi alag Vercel/Pages URL yaad rakhne ki zaroorat nahi,
aur cross-domain (CORS) error ka chance bhi khatam ho gaya.

## Step 1 — GitHub repo update karo

Apne **wahi private repo** (jisse `veyra` Worker already connected hai)
mein iska poora content daal do — puraana content is folder ke content se
**replace** kar dena, structure bilkul yehi rakhna:

```
wrangler.toml
package.json
public/index.html
public/cncveyralive.html
src/index.js
src/logic.js
```

GitHub web UI se "Add file → Upload files" se sab daal sakte ho, ya purane
files delete karke naye upload kar do.

## Step 2 — Cloudflare khud deploy kar dega

Chunki `veyra` Worker pehle se GitHub repo se connected hai (Workers
Builds), jaise hi tum GitHub par push/upload karoge, Cloudflare khud-ba-
khud naya build bana kar deploy kar dega — usi purane URL par:

```
https://veyra.mk096063.workers.dev
```

Agar dashboard mein manually deploy trigger karna ho: **Workers & Pages**
→ `veyra` → **Deployments** tab → last commit ke saamne **Retry
deployment** ya naya commit push karo, wo apne aap ban jaayega.

## Step 3 — Verify karo

Deploy hone ke baad (~30-60 second):

1. `https://veyra.mk096063.workers.dev` khol ke site check karo.
2. Turning tab mein jao, ek profile daal ke **GENERATE TURNING CODE**
   dabao — ab error nahi aana chahiye, G-code seedha aa jaayega.

## Baad mein CNC logic update karni ho to?

Sirf `src/logic.js` file edit karo aur GitHub par push kar do. `src/index.js`
(routing) ya `public/` folder ko chhedne ki zaroorat nahi padegi.

## Note

- Free Workers plan par ye chal jaayega, credit card zaroori nahi.
- `public/index.html` size mein bada hai (isme images base64 format mein
  embed hain) — ye static asset ki tarah serve hota hai, Worker script ke
  size-limit mein nahi ginta, isliye koi dikkat nahi aani chahiye.
- Agar future mein tum backend ko sirf apni site tak seedha rakhna chaho —
  already hai, kyunki same-origin hai. Koi extra CORS setting ki zaroorat
  hi nahi, isi wajah se ye purane Pages-based setup se simple/better hai.

## Video (Short / Tutorial) kaise lagayein

1. YouTube par video upload karo aur uska link copy karo.
2. `public/short.html` (Short ke liye) ya `public/tutorial.html` (Tutorial ke liye) kholo.
3. Script mein ye line dhundo aur quotes ke andar link paste karo:

```
const YOUTUBE_LINK = "";
```

4. GitHub par push karo — Home page par video apne aap chalne lagegi.
   Watch link, youtu.be link aur shorts link, teeno chalte hain.
