## 1
在.c中，有static函数，那么对于一个函数类型的tag，他可能在c文件中有2个或者多个定义，那么需要将所有的位置都展示出来，可能是
函数声明在上方，所以直接跳转到第一个tag的位置，不太合理
```
static int foo();

static int foo()
{
    return 0;
}
```
## 2
在c文件中，有static函数，那么对于一个函数类型的tag，他可能在c文件中有2个或者多个定义，那么需要将所有的位置都展示出来
可能因为宏的功能：存在2个函数，或者变量，或者结构体的实现,那么需要将foo 都展示出来
```
#if EN
typedef struct {
    int a;
} foo;
#else
typedef struct {
    int b; 
} foo;
#endif
```