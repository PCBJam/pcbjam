---
title: Cookie Policy
description: How PCBJam uses cookies and similar technologies, and the choices you have.
updated: 2026-07-27
---

This Cookie Policy explains how **PCBJam** ("PCBJam", "we", "us", "our") uses cookies and similar technologies — such as browser local storage, IndexedDB and cache storage — when you visit **pcbjam.com** or use the PCBJam application (the "Service"), and the choices you have.

PCBJam is operated by:

<div class="card">
<strong>Emergence-Engineering Kft.</strong> (Emergence-Engineering Korlátolt Felelősségű Társaság)<br>
Registered seat: 1123 Budapest, Nagyenyed utca 5. pinceszint, Hungary<br>
Company registration number (cégjegyzékszám): 01-09-380162<br>
Tax number (adószám): 29043424-2-43<br>
EU VAT: HU29043424<br>
Contact: <a href="mailto:hello@pcbjam.com">hello@pcbjam.com</a>
</div>

Emergence-Engineering Kft. is the **data controller** for cookies and similar technologies that we set. Where third parties (for example our payment provider) set their own technologies, they act as independent controllers for those — see Section 6.

This Cookie Policy is part of, and should be read together with, our [Privacy Policy](/privacy), which explains how we handle personal data more generally — including **the PCB designs, account data and preferences you store with us, which are held on our servers and are governed by the Privacy Policy, not this Cookie Policy.**

## 1. What this policy covers (and a quick word on where your data lives)

This policy is about information stored on, or read from, **your device** (your computer, phone or browser) — that is what cookie/ePrivacy law governs.

It is **not** about the design files, account information and preferences you save to PCBJam. Those are stored **on our servers**, and how we collect, use, retain and protect them is explained in our [Privacy Policy](/privacy). We mention this so the line is clear: *server-side storage of your work and settings is a privacy matter, not a cookie matter.*

## 2. What are cookies and similar technologies?

A **cookie** is a small text file that a website asks your browser to store on your device. Cookie law is **function-based, not name-based**: the same rules apply to any technology that **stores information on, or accesses information already stored on, your device.** That includes:

| Technology | What it is |
|---|---|
| **Local storage / session storage** | Browser key–value storage (also called HTML5 or DOM storage). |
| **IndexedDB** | A larger in-browser database — used by the application to cache itself and to hold an autosave/offline copy of work in progress. |
| **Cache Storage / Service Worker cache** | On-device storage of application files so they don't have to be re-downloaded on every visit. |
| **Pixels / tags / scripts** | Small pieces of code that can read or send information from your device. |

We refer to all of the above collectively as "cookies" in this policy for readability. **First-party** items are set by PCBJam; **third-party** items are set by another company (for example, our payment provider during checkout). **Session** items are cleared when you close your browser; **persistent** ones remain until they expire or you delete them.

## 3. Categories — and why we don't currently show a consent banner

We deliberately keep what we put on your device to a minimum. Everything we place on your device is either **strictly necessary** to run the Service or stores **no identifying information** at all. Things that would ordinarily be "preference cookies" — like your theme or layout — are saved **with your account on our servers** (or only for your current browser session), not in persistent storage on your device.

| Category | What it's for | On your device? | Consent needed? |
|---|---|---|---|
| **Strictly necessary** | Signing in, keeping your session secure, loading the application, and not losing your in-progress work. The Service cannot work without these. | Yes | **No** — exempt (but disclosed in Section 4). |
| **Functional / preferences** | Remembering choices such as theme, layout or last view. | **No** — saved with your account on our servers, or kept only for the current session. | n/a — not a device cookie. |
| **Analytics / performance** | Understanding, in aggregate, how the Service is used. Done **without cookies** and without identifying you (see Section 5). | No storage — the script runs in your browser but keeps nothing on your device. | Not requested — we consider none is required (see Section 5). |
| **Advertising / targeting** | **We do not use advertising or cross-site tracking cookies.** | No | n/a |

Because we currently place **nothing on your device that requires consent**, **we do not show a cookie consent banner — there is nothing non-essential to accept or reject.** The Service works the same whether or not you would have "accepted". If we ever introduce a technology that does require consent, we will ask for your consent before setting it.

## 4. Cookies and storage we use

The PCBJam application is rolling out in stages. We've split the tables so you can see what runs on the **public website today** versus what the **application** uses as features go live. Exact names and lifetimes for the application are being finalised and will be updated here when each feature ships.

### 4a. The public website — pcbjam.com (today)

**The PCBJam website does not set any cookies that require your consent.** Our usage measurement is cookieless (see Section 5), and joining the waitlist is handled by a server request — it does not place a cookie on your device.

If our hosting provider (Cloudflare) sets a strictly-necessary cookie for security or load-balancing in some circumstances, that cookie is essential to delivering the page you requested and carries no tracking function.

### 4b. The PCBJam application (as it rolls out)

Everything the application stores on your device is **strictly necessary** to deliver the editor you opened:

| Name / key *(indicative)* | Type | Provider | Purpose | Category | Retention |
|---|---|---|---|---|---|
| `pcbjam_session` | Cookie / token | PCBJam (first party) | Keeps you signed in so you can reach the designs saved to your account. | Strictly necessary | Session / short-lived, renewed on use |
| `pcbjam_csrf` | Cookie | PCBJam (first party) | Protects against cross-site request forgery and abuse. | Strictly necessary | Session |
| *App asset cache* | Cache Storage / IndexedDB | PCBJam (first party) | Stores the (large) KiCad/WebAssembly application files on your device. The editor is too large to re-download on every visit and cannot practically be delivered without caching its own program files. | Strictly necessary¹ | Persistent until cleared/updated |
| *Autosave / offline buffer* | IndexedDB | PCBJam (first party) | Keeps a local copy of your in-progress edits for crash recovery and offline editing. Your saved design is always stored on our servers; this is a working copy on your device. | Strictly necessary | Persistent until synced/cleared |

¹ We treat the application cache as necessary to deliver the editor you asked to open. If we determine that consent is required for it, we will ask for your consent before caching.

**Your preferences are not stored on your device.** Interface preferences (theme, layout, last view) are saved **with your account on our servers** — see the [Privacy Policy](/privacy) — or kept only for your current browser session. There is no preferences cookie to manage.

### 4c. Payments — Paddle (when you make a purchase)

If you buy a paid plan, checkout is handled by **Paddle** as our **Merchant of Record** (the reseller you actually transact with). During checkout, Paddle sets its **own** cookies and storage — for example to operate and secure the checkout and to **prevent fraud** — and, where required, asks for consent for any non-essential cookies **through its own controls**. Because Paddle is the Merchant of Record, **Paddle is an independent data controller** for the cookies it sets, and it manages consent for them itself; their purposes, names and lifetimes are described in Paddle's own notices, which we link to in Section 6.

## 5. Analytics: how we measure usage without cookies

We want to understand how PCBJam is used so we can improve it, **without tracking you.** We use **Plausible Analytics**, an EU-based, open-source, privacy-first analytics service operated by Plausible Insights OÜ. According to Plausible's [data policy](https://plausible.io/data-policy), and confirmed by our own inspection of the analytics script as currently shipped on this site, it:

- sets **no cookie** and stores **no identifier** on your device — visitors are counted using a **hash created from the incoming request**, and the script uses no cookies, local storage, or other device storage;
- does **not** keep a persistent visitor identifier — the hash is generated with a salt that is **rotated and deleted every 24 hours**, so you cannot be recognised from one day to the next, and your raw IP address is not stored;
- records **anonymous, aggregated** data points (such as page URL, referrer, approximate location, browser and device type) that are **not** used to build a profile of you or to follow you across other sites, and the data is **stored on servers in the EU**.

Because it stores nothing on your device and the data it records cannot identify you, **we consider that this measurement does not require your prior consent**, and it is not part of any consent banner.

We do **not** use Google Analytics, advertising pixels, or any cross-site tracking technology.

## 6. Third parties that may set their own cookies

| Third party | Role | What they may set | Their notice |
|---|---|---|---|
| **Paddle** (Paddle.com Market Limited and affiliates) | Merchant of Record / payments | Checkout, security and fraud-prevention cookies; their own non-essential cookies (with consent where required, via Paddle's own controls). Independent controller. | [Paddle Privacy Policy](https://www.paddle.com/legal/privacy); Paddle's cookie controls appear within its checkout. |
| **Plausible** (Plausible Insights OÜ) | Cookieless analytics | Nothing — no cookies and no device storage (see Section 5). | [Plausible Data Policy](https://plausible.io/data-policy) · [Plausible Privacy](https://plausible.io/privacy) |
| **Cloudflare** (Cloudflare, Inc.) | Hosting, CDN and network security | At most strictly-necessary hosting/security cookies. | [Cloudflare Privacy](https://www.cloudflare.com/privacypolicy/) |

We are not responsible for the privacy practices of these third parties; please review their notices. We update this list as our integrations change.

## 7. How to control cookies and storage in your browser

You can always control cookies and storage through your browser settings — including blocking or deleting cookies and clearing site storage (local storage, IndexedDB, cache). Help pages:

- **Chrome:** [support.google.com/chrome/answer/95647](https://support.google.com/chrome/answer/95647)
- **Firefox:** [support.mozilla.org](https://support.mozilla.org/kb/cookies-information-websites-store-on-your-computer)
- **Safari:** [support.apple.com](https://support.apple.com/guide/safari/manage-cookies-sfri11471/)
- **Edge:** [support.microsoft.com](https://support.microsoft.com/microsoft-edge/)

Please note that blocking **strictly-necessary** cookies and storage may stop you from signing in, prevent the editor from loading, or cause you to lose unsaved work.

## 8. Your rights and choices by region

### 8a. EU / EEA (including Hungary)

Cookies and similar technologies are governed by the **ePrivacy Directive (Article 5(3))** together with the **GDPR**. Non-essential technologies may be used only with your **consent** — freely given, specific, informed and unambiguous, and **withdrawable at any time as easily as you gave it**. As explained above, **we do not currently use any technology that we consider requires consent**, so none is requested; if that changes, we will ask for your consent first.

Because we are established in Hungary, our lead supervisory authority is the **Hungarian National Authority for Data Protection and Freedom of Information (NAIH)** — [naih.hu](https://naih.hu). You also have the right to lodge a complaint with the authority in your own EU/EEA country.

### 8b. United Kingdom

Cookies are governed by the **Privacy and Electronic Communications Regulations (PECR)** alongside the **UK GDPR**. As in the EU, non-essential technologies require consent (with a strictly-necessary exemption), and **we consider that we currently use none that requires consent**. You can complain to the **Information Commissioner's Office (ICO)** — [ico.org.uk](https://ico.org.uk).

### 8c. California / United States

We **do not sell** your personal information, and we **do not share** it for cross-context behavioural advertising, as those terms are used under the California Consumer Privacy Act (CCPA/CPRA). Because we neither sell nor share, no "Do Not Sell or Share My Personal Information" action is required of you today.

Should we ever introduce any technology that constitutes a "sale" or "share," we will add the **"Do Not Sell or Share My Personal Information"** (or **"Your Privacy Choices"**) link and **honour browser opt-out preference signals** such as the **Global Privacy Control (GPC)**, in each case as required by law.

## 9. Changes to this Cookie Policy

We may update this policy to reflect changes to the technologies we use or to the law. When we do, we will revise the "Last updated" date above and, if we ever introduce technologies that require consent, ask for your consent first.

## 10. Contact

Questions about this Cookie Policy or our use of cookies:

<div class="card">
<strong>Emergence-Engineering Kft.</strong><br>
1123 Budapest, Nagyenyed utca 5. pinceszint, Hungary<br>
Email: <a href="mailto:hello@pcbjam.com">hello@pcbjam.com</a>
</div>

For complaints, you may also contact your data protection authority (NAIH in Hungary, the ICO in the UK, or your local EU/EEA authority).
