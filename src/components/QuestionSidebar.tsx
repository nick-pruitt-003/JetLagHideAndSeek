import { useStore } from "@nanostores/react";
import { X } from "lucide-react";

import { AddQuestionDialog } from "@/components/AddQuestionDialog";
import { QuestionCardFor } from "@/components/QuestionCards";
import { SubwayStartDialog } from "@/components/SubwayStartDialog";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { SidebarContext as LeftSidebarContext } from "@/components/ui/sidebar-l-context";
import { SidebarContext as RightSidebarContext } from "@/components/ui/sidebar-r";
import {
    autoSave,
    isLoading,
    questions,
    save,
    triggerLocalRefresh,
} from "@/lib/context";
import { cn } from "@/lib/utils";

export const QuestionSidebar = () => {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const $autoSave = useStore(autoSave);
    const $isLoading = useStore(isLoading);
    const leftSidebar = useStore(LeftSidebarContext);
    const rightSidebar = useStore(RightSidebarContext);

    return (
        <Sidebar>
            <div className="flex items-center justify-between">
                <h2
                    className={cn(
                        "ml-4 font-poppins text-2xl",
                        // The sheet's drag handle already pads the top.
                        leftSidebar.isMobile ? "mt-1" : "mt-4",
                    )}
                >
                    Questions
                </h2>
                {/* Phones only: on desktop the map's sidebar trigger does
                    this. Tied to isMobile, not `md:`, so a phone held
                    sideways still gets a way to close the sheet. */}
                {leftSidebar.isMobile && (
                    <button
                        type="button"
                        aria-label="Close questions"
                        className="mr-2 mt-1 rounded-md p-2"
                        onClick={() => {
                            leftSidebar.setOpenMobile(false);
                        }}
                    >
                        <X className="h-5 w-5" />
                    </button>
                )}
            </div>
            <SidebarContent>
                {$questions.map((question) => (
                    <QuestionCardFor key={question.key} question={question} />
                ))}
            </SidebarContent>
            <SidebarGroup className="in-data-[keyboard-open=true]:hidden">
                <SidebarGroupContent>
                    <SidebarMenu data-tutorial-id="add-questions-buttons">
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                onClick={() => {
                                    // Mobile: swap drawers so the hiding-zone
                                    // controls are reachable while questions are open.
                                    leftSidebar.setOpenMobile(false);
                                    if (rightSidebar.isMobile) {
                                        rightSidebar.setOpenMobile(true);
                                    } else {
                                        rightSidebar.setOpen(true);
                                    }
                                }}
                                disabled={$isLoading}
                            >
                                Open Hiding Zones
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <AddQuestionDialog>
                                <SidebarMenuButton disabled={$isLoading}>
                                    Add Question
                                </SidebarMenuButton>
                            </AddQuestionDialog>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SubwayStartDialog>
                                <SidebarMenuButton disabled={$isLoading}>
                                    Random Start Station
                                </SidebarMenuButton>
                            </SubwayStartDialog>
                        </SidebarMenuItem>
                        {/* On a phone the footer is fixed under a half-height
                            sheet, so every row costs question space. */}
                        {!leftSidebar.isMobile && (
                            <SidebarMenuItem>
                                <a
                                    href="https://github.com/taibeled/JetLagHideAndSeek"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <SidebarMenuButton className="bg-emerald-600 transition-colors">
                                        Star this on GitHub! It&apos;s free :)
                                    </SidebarMenuButton>
                                </a>
                            </SidebarMenuItem>
                        )}
                        {!$autoSave && (
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    className="bg-blue-600 p-2 rounded-md font-semibold font-poppins transition-shadow duration-500"
                                    onClick={save}
                                    disabled={$isLoading}
                                >
                                    Save
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        )}
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
        </Sidebar>
    );
};
