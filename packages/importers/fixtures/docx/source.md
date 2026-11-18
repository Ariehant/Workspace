---
title: Gripper design review
---

# Overview

The gripper picks parts from a **moving conveyor** with a reach of *60 cm*. See the [calibration notes](https://example.com/calibration).

## Goals

- Pick 30 parts a minute
    1. Detect the part
    2. Plan the grasp
- Keep the payload under 2 kg

> Measure twice, cut once.

## Joint limits

| Joint    | Range  | Max speed |
|----------|--------|-----------|
| Shoulder | ±170°  | 180°/s    |
| Elbow    | ±135°  | 225°/s    |

![The arm, from above](arm.png)

```
def reach(l1, l2):
    return l1 + l2
```

Torque is checked at 12 V.[^1]

[^1]: With the servos warm.
