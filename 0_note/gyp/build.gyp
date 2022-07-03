{
  'targets': [{
    'target_name': 'hello',
    'type': 'executable',
    'dependencies': [],
    'variables': {
      'variables': {
        'variables': {
          'name': 'goodman'
        },
        'name': '<(name)' # 引用当前范围内variables中的变量
      },
      'name': '<(name)' # 引用当前范围内variables中的变量
    },
    'defines': [
      'DEFINE_FOO',
      'DEFINE_A_VALUE=value',
    ],
    'include_dirs': [
      'include',
    ],
    'includes': [
      'test.gypi',
    ],
    'sources': [
      'src/main.c',
    ],
    'actions': [{
      'action_name': 'hello',
      'inputs': [
        'hello.input',
      ],
      'outputs': [
        'hello.output',
      ],
      'action': ['echo', '<(name)'],
    }]
  }, ],
}
