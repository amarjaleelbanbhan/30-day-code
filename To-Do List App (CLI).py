# To-Do List App (CLI)
print("--------------------------------------------")
print("      Welcome to the To-Do List App!")
print("---------------------------------------------")
def display_tasks(task):
    if not task:
        print("No task available.")
    else:
        print("Current Tasks:")
        for index, item in enumerate(task, start=1):
            print(f"{index}. {item}")
def add_task(task):
    new_task = input("Enter the task to add: ")
    if new_task:
        task.append(new_task)
        print(f"Task '{new_task}' added successfully.")
    else:
        print("Task content cannot be empty.")
def remove_task(task):
    if not task:
        print("No task available to remove.")
    else:
        display_tasks(task)
        try:
            task_index = int(input("Enter the task number to remove: "))
            if 1 <= task_index <= len(task):
                remove_task = task.pop(task_index - 1)
                print(f"Task '{remove_task}' removed successfully.")
            else:
                print("Invalid task number. Please try again.")
        except ValueError:
            print("Invalid input! Please enter a valid task number.")
def to_do_list_app():
    
    while True:
        print("\nTo-Do List Menu:")
        print("1. Display Tasks")
        print("2. Add Task")
        print("3. Remove Task")
        print("4. Exit")
        choise = input("Enter your choice (1/2/3/4): ")
        if choise == '1':
            display_tasks(task)
        elif choise == '2':
            add_task(task)
        elif choise == '3':
            remove_task(task)
        elif choise == '4':
            print("Exiting the To-Do List App. Goodbye!")
            break
        else:
            print("Invalid choice! Please select a valid option.")
task = []
to_do_list_app()
# This code implements a simple command-line interface (CLI) for a To-Do List application