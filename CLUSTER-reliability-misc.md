# draft(cluster): reliability misc — dispatcher, registration, portability (7 P2-P4 issues)

Closes #2281, #2279, #2634, #2629, #2363, #2548, #2454

Fence queued incident delivery by durable episode state (#2281, P2). Wire registration write-path + delivery daemon (#2279, P3). Non-portable shell shebangs and ps flags in deploy scripts (#2634, P3). 10+ fetch() calls lack AbortSignal.timeout() (#2629, P2). Remove fixed-time child PID race from new-command ownership coverage (#2363, P3). Replay: access approval reports success after queued-message replay error (#2548, P4). Guard sweep: no other node-to-shell integer captures are vulnerable (#2454, P3).

All guards pass.
