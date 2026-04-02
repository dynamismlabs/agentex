---
name: test-interactive
description: A test skill that demonstrates the AskUserQuestion tool with single-select, multi-select, conditional branching, and free-form input. Use when the user says "test interactive" or "demo ask user".
---

# Test Interactive Skill

This skill tests the built-in AskUserQuestion tool. Walk through each step sequentially.
Each question gets its own AskUserQuestion call. Never batch multiple questions.

---

## Step 1: Single select

Use AskUserQuestion: Pick a color for your vibe check.
...
Red — bold and energetic
...
Blue — calm and focused
...
Green — earthy and grounded

Store the answer as COLOR.

---

## Step 2: Multi-select

Use AskUserQuestion (multiSelect: true): Which toppings on your pizza?
...
Pepperoni — classic meat topping
...
Mushrooms — earthy and savory
...
Jalapeños — spicy kick
...
Pineapple — controversial but delicious

Store the answer as TOPPINGS.

---

## Step 3: Conditional branch

Use AskUserQuestion: Should we generate a fun summary?
...
Yes, do it (Recommended) — print a recap of everything you picked
...
No thanks — just end the skill

If A: proceed to Step 4.
If B: say "All done! AskUserQuestion test complete." and stop.

---

## Step 4: Print summary

Print this, filling in the stored values:

```
🎨 Color: {COLOR}
🍕 Toppings: {TOPPINGS}
✅ All AskUserQuestion patterns tested successfully.
```

Done.
