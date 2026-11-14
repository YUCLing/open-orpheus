# AI-Assisted Contribution Policy

[中文版](../AI_POLICY.md)

This policy covers every pull request in this repository, along with the issues, comments, and review threads around it.

## In One Line

**We don't ban AI. We ban submitting changes you don't understand.**

Which tools you use, which model, how much of the work it did — none of that is our business, and you don't need to declare it. The only requirement is this: **you can explain every line in your pull request yourself.**

## Why This Policy Exists

AI has made it cheap to produce code that looks like it works. It has not made reviewing that code any cheaper.

Take a two-thousand-line pull request with a thorough description and a green test suite. If the author cannot say _why the change is needed_, the entire cost of review shifts onto the maintainer: reconstructing the motivation, reproducing the problem, judging the edge cases, and then owning whatever happens after merge. That is not an efficiency problem, it is a sustainability problem — there is a finite amount of code one maintainer can read, and these pull requests exhaust it.

So what gets judged here is never "did you use AI." It is whether the person submitting the change understands it and can stand behind it. Code written by hand that the author doesn't understand fails the same standard.

## Welcome: AI-Assisted

AI is a good tool. None of the following is a problem:

- Drafting code, writing tests, writing docs, translating, fixing lint errors
- Asking it to explain unfamiliar code or how a protocol or library behaves — then verifying the answer yourself
- Using it for mechanical refactors while you check, section by section, that behavior is unchanged
- Using it to make something you already understand easier to read

There is exactly one distinction: **AI produces the draft; your name is on it.** The draft can come from anywhere. The responsibility can't.

## Not Accepted: Fully Vibed

A pull request gets called "vibed" not because it looks AI-written, but because of symptoms like these:

- **No answer to "why."** Ask what breaks without the change, and the reply describes what the change does.
- **The problem doesn't exist.** A settings migration for a key that no released build has ever written. A fallback branch for a failure nobody can describe the trigger for. A feature disabled outright over a hypothetical incompatibility. Who hits it, where's the log, how do you reproduce — no answer.
- **Runaway scope.** One pull request arrives with a small framework attached: a new settings layer, a new IPC channel, a new factory, a new abstraction — all in service of a single toggle.
- **Reinventing a wheel, then patching it.** Hand-rolling what a mature library already does, then writing patches and tests for the edge cases you introduced, until the patches themselves become the maintenance burden.
- **The description is the diff in prose.** "Implements X, refactors Y, unifies Z" throughout, and not one sentence about what users hit before this.
- **Lots of tests, none of them about the problem.** Every test pins an implementation detail; none exercises the real scenario.
- **One follow-up question and it falls apart.** The description is excellent, but ask which call path a step takes effect on, or what happens when it fails, and the answer becomes another restatement.

None of these are unique to AI. **We judge the result, not the tool, and we won't ask you to prove your innocence.**

## The Three Questions

For any non-trivial change, maintainers may ask you to answer:

1. **What breaks without this?** Be specific — observable behavior, an error, a test.
2. **Who runs into it?** Under what conditions? Is there an issue, a log, upstream documentation, or a minimal reproduction?
3. **How do you know it works?** Which command, which test, verified by hand on which machine or desktop environment — and which parts you did **not** verify.

If all three come back empty, the code is probably solving a problem that doesn't exist. That is exactly what this policy exists to stop.

## Answering in Review

Questions in review are part of review. They are not hostility.

- **Answer in your own words.** Don't paste the pull request description, and don't let AI write the reply. You can have AI polish the phrasing, but **the answer has to be yours.**
- **Answer "why," not "what."** If a sentence is just the code translated into prose, it hasn't answered anything.
- **Bring evidence when you have it.** A link, a log, reproduction steps, the protocol text, the exact upstream source location — all of these beat adjectives.
- **"I don't know" is fine, once.** Follow it with "I'll go find out," then come back.
- **The second time you can't answer the same question, that part of the code isn't ready.** Shrinking the scope or deleting the part you don't understand works better than explaining harder.
- **Don't answer "why is this needed" with more code.** Another fallback, another flag, another migration is not a reason.

A quick self-test: **if someone pointed at any line in the diff and asked "why does this exist," could you answer within thirty seconds?**

### One Question, Two Answers

> Why does this fallback branch exist?

**Fails:** "The branch skips addresses already tried, avoids reconnecting, and rescans once the round is exhausted." That is what the code does. Anyone else reading the diff could have written it.

**Passes:** "I hit `<symptom>` on `<environment>` (reproduction steps and log below), and without it `<specific consequence>`. It isn't a common scenario, so I limited its effect to `<scope>`; if you don't think it's worth keeping, I'll delete it, and what we lose is `<what>`."

The most valuable part of the second answer is usually the last clause: **you know what it costs and you're willing to own deleting it.** That says more about whether you read your own code than any "implements..." ever will.

## Scope and Prior Discussion

Open an issue to discuss the approach first if the change would:

- Add a dependency or native module, or change a cross-process contract or custom protocol
- Introduce a subsystem, or exceed roughly 10 files / 400 meaningful lines in one pull request
- Modify an upstream dependency (patch, vendor, backport a fix)

One pull request, one problem. The larger the scope, the more the author has to understand, and the less likely real review becomes. "This is too big, I'll need some time to get through it" is usually not a scheduling problem — it's a pull request that should have been split.

## What Happens

| Situation                                                            | Outcome                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Explanation questions go unanswered, or answers don't match the diff | Stays in review; not merged                                             |
| The same question is dodged repeatedly, or scope won't be reduced    | May be closed                                                           |
| No substantive reply to explanation questions within 14 days         | May be closed; reopen any time with answers, no new pull request needed |
| No activity at all for 30 days                                       | May be closed                                                           |

Closing isn't punishment. It moves an unfinished pull request out of the queue. Reopening needs no apology — only answers.

An approval from the review AI **is not** a merge. It reads the diff; it cannot read your understanding. The maintainer's questions still stand.

## Before You Open the Pull Request

Check each of these:

- [ ] I can say in one sentence what this solves and what breaks without it
- [ ] I can explain why each changed file was changed, without looking at AI output
- [ ] I built and ran it, and I know which platforms or environments were **not** verified
- [ ] For every new branch, abstraction, and dependency, I can say what it guards against and who hit it
- [ ] I wrote no migration for users who don't exist, and no fallback for a failure I can't reproduce
- [ ] I can answer "what happens if this part is deleted"
- [ ] The description explains motivation and tradeoffs, not the diff in prose
- [ ] If someone pointed at any line right now and asked, I could answer on the spot

If that last one fails, hold off. Deleting the part you can't explain or taking the time to understand it is almost always faster than submitting it.
