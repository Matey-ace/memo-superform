"""性能基准、契约与等价性测试。

标记为 package 是为了让 ``python -m unittest discover -s tests/perf -t .``
能收集到这里的测试。``tests/run.ps1`` 依赖这一点把性能/契约回归纳入全量运行；
没有这个文件时 discover 会报 ``Start directory is not importable``，
测试将静默不参与回归。
"""