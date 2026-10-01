# Sources and terms

What They Buy shows notices from official public procurement portals. Each notice belongs to the
portal that published it and is reused under that portal's terms; every result links to the
original notice, which is the authoritative version. This repository's MIT licence covers the code
and the word-to-code dictionary, not the notices.

"Not yet confirmed" means we believe the data is published for reuse but have not yet read and
recorded the operator's reuse terms. If you operate one of these portals and want us to change how
we use it, open an issue on this repository and we will act on it.

| Source | Operator | What we read | Terms as we understand them |
|---|---|---|---|
| [TED](https://ted.europa.eu) | Publications Office of the EU | TED search API, at search time | EU reuse policy (Commission Decision 2011/833/EU); © European Union |
| [BOAMP](https://www.boamp.fr) | DILA, France | BOAMP open-data API, at search time | Licence Ouverte / Etalab |
| [SAM.gov](https://sam.gov) | US General Services Administration | Contract Opportunities daily bulk extract (API key) | US federal government data, public domain |
| [Find a Tender](https://www.find-tender.service.gov.uk) | UK Cabinet Office | OCDS release packages API | Open Government Licence v3 |
| [Contracts Finder](https://www.contractsfinder.service.gov.uk) | UK Cabinet Office | v2 notice search API | Open Government Licence v3 |
| [Prozorro](https://prozorro.gov.ua) | Prozorro, Ukraine | public tenders API (change feed) | Published as open data; terms not yet confirmed |
| [AusTender](https://www.tenders.gov.au) | Australian Department of Finance | current approaches-to-market RSS feed | Listed as CC BY 3.0 AU; not yet confirmed |
| [PLACSP](https://contrataciondelsectorpublico.gob.es) | Spanish Ministry of Finance | open-data ATOM feeds (CODICE) | Spanish public-sector information reuse; terms not yet confirmed. The host's robots.txt disallows all bots; we read only the feeds published for reuse, slowly and with an identified user agent |
| [PNCP](https://pncp.gov.br) | Brazilian federal government | public consultation API | Brazilian public open data; terms not yet confirmed |
| [TenderNed](https://www.tenderned.nl) | Dutch government | public publication web service | Listed as CC0 on data.overheid.nl |
| [BZP / e-Zamówienia](https://ezamowienia.gov.pl) | Polish Public Procurement Office (UZP) | BZP notice API (no access request needed under the UZP API terms) | Polish public information; terms not yet confirmed |
| [oeffentlichevergabe.de](https://oeffentlichevergabe.de) | German federal government | OpenData daily eForms exports | Reported as CC0; not yet confirmed |
| [Doffin](https://www.doffin.no) | DFØ, Norway | public v2 notice API (API key) | NLOD; not yet confirmed |

Not searched: **CanadaBuys** (Canada) refuses requests from our servers. We don't work around a
block; the source stays off until the operator gives access.

## How we access sources

- We identify ourselves in every request's user agent with a link back to this project.
- We follow robots.txt and site terms for web pages. Documented open-data feeds and APIs are read
  with light, paced use. We never use proxies, headless browsers or disguised clients to get past a
  block.
- Daily sources are copied once a day by a GitHub Actions job; live sources are asked only when
  someone searches.

## Fonts

Barlow Condensed, Crimson Pro and JetBrains Mono are served from this site under the SIL Open Font
Licence 1.1; the licence texts are in `assets/fonts/`.
