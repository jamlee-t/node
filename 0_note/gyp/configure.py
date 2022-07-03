#!/usr/bin/python3

# -*- coding: utf-8 -*-

import sys
import os

sys.path.insert(0, os.path.join('../..', 'tools', 'gyp', 'pylib'))

from gyp.common import GetFlavor
flavor_params = {}
flavor = GetFlavor(flavor_params) # 获取到操作系统类型

# --generator-output 和 -G 指定了输出目录的位置。Node.js 中的 makefile 文件是自己写的，而不是 gyp 生成的。
import gyp
d = os.path.dirname(os.path.realpath(__file__))
gyp.main(['build.gyp', '-f', 'make-' + flavor, '--depth=.', '--no-parallel', '--generator-output', os.path.join(d, 'out'),
'-Goutput_dir=' + os.path.join(d, 'out')])
