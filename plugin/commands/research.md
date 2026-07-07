---
description: Codebase/technical research - parallel explorer sweep, deep-read workers, cited synthesis, skeptic-checked conclusions
argument-hint: <question>
---

Run the fabel research pipeline.

**Question**: $ARGUMENTS

First read the `fabel:doctrine` skill (evidence rules especially). Then:

## 1. Sweep
Decompose the question into 2-5 sub-questions. Spawn `explorer` subagents IN PARALLEL
(one per sub-question territory) to LOCATE the relevant code/docs — maps only, not
answers.

## 2. Deep-read
From the sweep maps, assign the hot files to `researcher` subagents IN PARALLEL, one
per sub-question, each with its concrete file list. Researchers answer with
[observed]/[inferred]-tagged, `file:line`-cited claims.

## 3. Synthesize
Combine the researcher answers into ONE answer to the original question, in this
thread. Preserve citations. Where researchers contradicted each other, resolve by
reading the disputed code yourself — never by picking the majority.

## 4. Attack
Identify the 2-3 claims your answer most depends on. Spawn one `skeptic` per claim,
in parallel. Weaken or fix any claim that comes back REFUTED or PLAUSIBLE; rerun the
affected part of stage 3 if a load-bearing claim fell.

## 5. Answer
Lead with the direct answer to the question in 2-4 sentences. Then the supporting
evidence with citations, then open questions/gaps. Tag anything that remains
[inferred]. An honest "the codebase doesn't answer this" is a valid conclusion.
