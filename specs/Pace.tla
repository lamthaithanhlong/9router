------------------------------ MODULE Pace ------------------------------
\* The router's pace for a model (open-sse/services/modelRateLimit.js). Callers (Claude's workers, the Risu app, test judges)
\* each send requests; the upstream fails ("503 No available channel") when more than Cap run at once.
\*   SHARED = TRUE : one pace in the router for every caller (shipped)
\*   SHARED = FALSE: each caller paces itself to Cap (a limit in every client, the "each pod counts alone" failure)
\* Invariants: NeverOverCap (upstream never sees more than Cap at once), NoLeak (the running count is exactly the holders),
\* Fifo (a waiter is never overtaken by one that came after it).
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Callers, Cap, SHARED, MaxReq
VARIABLES state, queue, active, sent
vars == <<state, queue, active, sent>>
\* state[c] in {"idle","waiting","running"}; queue: the shared FIFO (SHARED) ; active[c]: running per caller (for SHARED=FALSE)
Init == /\ state = [c \in Callers |-> "idle"] /\ queue = <<>> /\ active = [c \in Callers |-> 0] /\ sent = 0
Running == {c \in Callers : state[c] = "running"}
Ask(c) == /\ state[c] = "idle" /\ sent < MaxReq
          /\ state' = [state EXCEPT ![c] = "waiting"] /\ queue' = Append(queue, c) /\ sent' = sent + 1 /\ UNCHANGED active
\* a slot is given to the head of the queue (SHARED) or to any waiter whose own pace has room (per caller)
Grant == /\ queue # <<>>
         /\ LET c == Head(queue) IN
              /\ IF SHARED THEN Cardinality(Running) < Cap ELSE active[c] < Cap
              /\ state' = [state EXCEPT ![c] = "running"] /\ active' = [active EXCEPT ![c] = @ + 1] /\ queue' = Tail(queue)
         /\ UNCHANGED sent
GrantAny(c) == /\ ~SHARED /\ state[c] = "waiting" /\ active[c] < Cap
               /\ \E i \in 1..Len(queue) : queue[i] = c /\ queue' = SubSeq(queue, 1, i-1) \o SubSeq(queue, i+1, Len(queue))
               /\ state' = [state EXCEPT ![c] = "running"] /\ active' = [active EXCEPT ![c] = @ + 1] /\ UNCHANGED sent
\* the upstream call returns (success or error: the finally releases)
Done(c) == /\ state[c] = "running" /\ state' = [state EXCEPT ![c] = "idle"] /\ active' = [active EXCEPT ![c] = @ - 1] /\ UNCHANGED <<queue, sent>>
\* a waiter past maxWaitMs leaves the queue with a 429
GiveUp(c) == /\ state[c] = "waiting" /\ \E i \in 1..Len(queue) : queue[i] = c /\ queue' = SubSeq(queue, 1, i-1) \o SubSeq(queue, i+1, Len(queue))
             /\ state' = [state EXCEPT ![c] = "idle"] /\ UNCHANGED <<active, sent>>
Next == Grant \/ \E c \in Callers : Ask(c) \/ GrantAny(c) \/ Done(c) \/ GiveUp(c)
Spec == Init /\ [][Next]_vars

NeverOverCap == Cardinality(Running) <= Cap
NoLeak == \A c \in Callers : active[c] = IF state[c] = "running" THEN 1 ELSE 0
Fifo == SHARED => \A c \in Callers : state[c] = "waiting" => \E i \in 1..Len(queue) : queue[i] = c
=============================================================================
