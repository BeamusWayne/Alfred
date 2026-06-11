---
layout: home
hero:
  name: Alfred
  text: Your agent says "done." Alfred proves it.
  tagline: An autonomous coding CLI where "done" means the test suite actually passed — and every hands-off run leaves a signed, tamper-evident receipt you can replay.
  image:
    src: /favicon.svg
    alt: "Alfred — the A-mark: a verify gate as the crossbar"
  actions:
    - theme: brand
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: Try it offline — no API key
      link: /guide/quickstart#offline-demo
    - theme: alt
      text: Architecture
      link: /architecture/overview
features:
  - title: Verifiable autonomy
    details: A feature_list state machine driven by an objective verify gate — only a captured exit 0 (plus a rubric pass) marks a feature done — with an HMAC hash-chained ledger you can audit and a journal you can replay.
  - title: Best-of-breed, not a clone
    details: Memory, orchestration, code intelligence, security, and model routing synthesized from across the ecosystem. Every choice is adopt / adapt / reject, grounded in an ADR.
  - title: Security no mainstream harness ships
    details: Lethal-trifecta defense at the content layer — taint fencing, a default-deny egress allow-list, secret redaction, and a dual-LLM quarantine for untrusted input.
  - title: Local-first & inspectable
    details: Memory, skills, hooks, journals, and signed ledgers are plain files under .alfred/ that you can cat, grep, and git diff. No cloud control plane.
---

## Watch a verified run {#watch}

The terminal below replays a **real recorded run** from [`examples/demo`](https://github.com/BeamusWayne/Alfred/tree/main/examples/demo) — implement → objective verify gate → signed ledger row → a one-byte tamper, caught.

<ReplayTerminal />

**Where this pays off:** [overnight autonomous builds](/guide/use-cases#overnight) · [CI gates for agent changes](/guide/use-cases#ci-gate) · [hands-off runs on untrusted input](/guide/use-cases#untrusted) · [receipts you can hand to a reviewer](/guide/use-cases#receipts)
